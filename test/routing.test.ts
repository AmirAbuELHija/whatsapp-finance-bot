import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiApi, classifyFailure, quotaScope } from '../src/adapters/llm/gemini/gemini-api.js';
import { QuotaTracker, quotaDay } from '../src/adapters/llm/gemini/gemini-quota.js';
import { GeminiChatProvider, isWeakAnswer, startRung } from '../src/adapters/llm/gemini/gemini-chat-provider.js';
import { ModelCatalog, ModelHealth, classifyModel, isExcluded } from '../src/adapters/llm/gemini/gemini-models.js';
import { toGeminiRequest } from '../src/adapters/llm/gemini/gemini-mapping.js';
import { JsonFileHealthStore } from '../src/adapters/llm/gemini/model-health-file.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiRater } from '../src/adapters/llm/gemini/gemini-rater.js';
import { OpenAICompatibleProvider } from '../src/adapters/llm/openai-provider.js';
import { buildRater, createGeminiShared } from '../src/app/container.js';
import { GEMINI } from '../src/config/constants.js';
import { HeuristicRater, heuristicScore, parseScore } from '../src/core/ai/request-rating.js';
import type { ChatResponse } from '../src/core/types.js';
import { ChatAgent } from '../src/services/agent/chat-agent.js';
import { buildToolRegistry } from '../src/services/agent/tool-registry.js';
import { ConversationHistory } from '../src/services/conversation/history.js';
import { fakeChatClient, fakeFetch, fakeMarket, makeConfig, reply, response } from './helpers.js';

const MODELS = [
  'gemini-flash-latest',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.1-pro',
  'gemini-3.9-flash-preview',
  'gemini-3.8-flash-tts',
  'text-embedding-005',
];
const listing = (names = MODELS) =>
  response(200, {
    models: names.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })),
  });
const text = (t: string, finishReason = 'STOP') =>
  response(200, { candidates: [{ finishReason, content: { parts: [{ text: t }] } }] });
const timeout = () => {
  throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
};

/** Fake Gemini: model list + per-model behaviour; records which model handled each call and the thinking level sent. */
function gemini(handle: (model: string, body: any) => Response, names = MODELS) {
  const used: { model: string; thinking?: string }[] = [];
  const f = fakeFetch((url, init) => {
    if (url.includes('/models?')) return listing(names);
    const model = /models\/([^:]+):/.exec(url)![1]!;
    const body = JSON.parse(init.body as string);
    used.push({ model, thinking: body.generationConfig?.thinkingConfig?.thinkingLevel });
    return handle(model, body);
  });
  return { api: new GeminiApi('AQ.key', f.fetchImpl), used, fetchImpl: f.fetchImpl };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

test('catalog: tiers, newest version first, "-latest" aliases last, previews and special models excluded', () => {
  assert.deepEqual(classifyModel('gemini-3.5-flash-lite'), {
    name: 'gemini-3.5-flash-lite',
    tier: 'lite',
    version: 3.5,
    alias: false,
  });
  assert.equal(classifyModel('gemini-3.9-flash-preview'), null);
  assert.equal(classifyModel('gemini-flash'), null);
  const catalog = ModelCatalog.fromNames(MODELS);
  assert.deepEqual(
    catalog.models('lite').map((m) => m.name),
    ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest'],
  );
  assert.deepEqual(
    catalog.models('flash').map((m) => m.name),
    ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest'],
  );
  assert.deepEqual(
    catalog.models('pro').map((m) => m.name),
    ['gemini-3.1-pro'],
  );
  assert.equal(catalog.videoOrder[0], 'gemini-3.8-flash');
});

test('catalog falls back to known model names when listing is refused', async () => {
  const f = fakeFetch((url) =>
    url.includes('/models?') ? response(403, { error: { message: 'denied' } }) : text('x'),
  );
  const catalog = await new GeminiApi('k', f.fetchImpl).catalog();
  assert.ok(catalog.models('flash').length > 0);
  assert.equal(catalog.models('flash').at(-1)!.name, 'gemini-flash-latest');
});

// ── Rating ───────────────────────────────────────────────────────────────────

test('heuristic rating: lookups low, normal questions mid, analysis high (English, Hebrew, Arabic)', () => {
  assert.ok(heuristicScore('price of TEVA?') <= 3);
  assert.ok(heuristicScore('כמה זה 100 דולר?') <= 3);
  const mid = heuristicScore('what is an ETF?');
  assert.ok(mid >= 4 && mid <= 6, String(mid));
  assert.ok(heuristicScore('explain why the Fed raises rates') >= 7);
  assert.ok(heuristicScore('compare NVDA and AMD for a 5 year portfolio, risks and scenarios') >= 9);
  assert.ok(heuristicScore('תסביר לי למה הבורסה ירדה') >= 7);
  assert.ok(heuristicScore('اشرح لي ما هو صندوق المؤشرات') >= 7);
  assert.equal(parseScore('7'), 7);
  assert.equal(parseScore('Score: 10/10'), 10);
  assert.equal(parseScore('high'), null);
});

test('AI rater: uses the lightest model; falls back to the heuristic on junk or errors', async () => {
  const good = gemini(() => text('8'));
  const rated = await new GeminiRater(good.api, new ModelHealth()).rate('anything');
  assert.deepEqual(rated, { score: 8, source: 'ai' });
  assert.equal(good.used[0]!.model, 'gemini-3.5-flash-lite');

  const junk = await new GeminiRater(gemini(() => text('I think it is complicated')).api, new ModelHealth()).rate(
    'price of TEVA?',
  );
  assert.equal(junk.source, 'heuristic');
  const down = await new GeminiRater(gemini(() => timeout()).api, new ModelHealth()).rate('price of TEVA?');
  assert.equal(down.source, 'heuristic');

  const shared = createGeminiShared(makeConfig({ GEMINI_API_KEY: 'k' }), undefined);
  assert.ok(buildRater(makeConfig({ GEMINI_API_KEY: 'k' }), shared) instanceof GeminiRater);
  assert.ok(
    buildRater(makeConfig({ GEMINI_API_KEY: 'k', ROUTER_RATING: 'heuristic' }), shared) instanceof HeuristicRater,
  );
  assert.ok(buildRater(makeConfig({}), shared) instanceof HeuristicRater);
});

// ── Routing ──────────────────────────────────────────────────────────────────

test('score → starting rung, and the plan for each band', () => {
  assert.deepEqual([1, 5, 6, 7, 8, 9, 10].map(startRung), [0, 0, 1, 1, 2, 2, 3]);
  const router = new GeminiChatProvider(new GeminiApi('k'));
  const catalog = ModelCatalog.fromNames(MODELS);
  const first = (score: number) => router.plan(catalog, score)[0]!;
  assert.deepEqual(first(2), { model: 'gemini-3.5-flash-lite', tier: 'lite', thinkingLevel: 'low', rung: 0 });
  assert.deepEqual(first(6), { model: 'gemini-3.8-flash', tier: 'flash', thinkingLevel: 'low', rung: 1 });
  assert.deepEqual(first(8), { model: 'gemini-3.8-flash', tier: 'flash', thinkingLevel: 'high', rung: 2 });
  assert.deepEqual(first(10), { model: 'gemini-3.1-pro', tier: 'pro', thinkingLevel: 'high', rung: 3 });
  // Plan climbs from the start rung, then falls back to lighter rungs as a last resort.
  assert.deepEqual(
    router.plan(catalog, 8).map((s) => `${s.model}/${s.thinkingLevel}`),
    ['gemini-3.8-flash/high', 'gemini-3.1-pro/high', 'gemini-3.8-flash/low', 'gemini-3.5-flash-lite/low'],
  );
  // No Pro on this key: a 10/10 request goes to the strongest Flash setting.
  assert.equal(
    router.plan(ModelCatalog.fromNames(['gemini-3.8-flash', 'gemini-3.5-flash-lite']), 10)[0]!.thinkingLevel,
    'high',
  );
});

test('resting models are skipped; a pinned GEMINI_MODEL goes first; fixed thinking level overrides the ladder', () => {
  let now = 0;
  const health = new ModelHealth(() => now);
  health.rest('gemini-3.8-flash', 'busy');
  const catalog = ModelCatalog.fromNames(MODELS);
  assert.equal(new GeminiChatProvider(new GeminiApi('k'), { health }).plan(catalog, 6)[0]!.model, 'gemini-3.5-flash');
  now = GEMINI.cooldownMs.busy + 1;
  assert.equal(new GeminiChatProvider(new GeminiApi('k'), { health }).plan(catalog, 6)[0]!.model, 'gemini-3.8-flash');
  assert.equal(
    new GeminiChatProvider(new GeminiApi('k'), { model: 'gemini-3.1-pro' }).plan(catalog, 2)[0]!.model,
    'gemini-3.1-pro',
  );
  assert.equal(
    new GeminiChatProvider(new GeminiApi('k'), { thinkingLevel: 'high' }).plan(catalog, 2)[0]!.thinkingLevel,
    'high',
  );
});

test('technical failures try another model at the same level, then climb; failed models rest', async () => {
  const g = gemini((model) =>
    model === 'gemini-3.5-flash-lite'
      ? timeout()
      : model === 'gemini-flash-lite-latest'
        ? response(503, { error: { message: 'high demand' } })
        : text(`answer from ${model}`),
  );
  const router = new GeminiChatProvider(g.api);
  const res = await router.create({ messages: [{ role: 'user', content: 'hi' }], score: 2 });
  assert.equal(res.choices[0]!.message.content, 'answer from gemini-3.8-flash');
  assert.deepEqual(
    g.used.map((u) => u.model),
    ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash'],
  );
  g.used.length = 0;
  await router.create({ messages: [{ role: 'user', content: 'again' }], score: 2 });
  assert.equal(g.used[0]!.model, 'gemini-3.8-flash'); // both lite models are resting
});

test('escalation on weak answers: refusal or cut-off on a light model → stronger model', async () => {
  const g = gemini((model, body) =>
    model.includes('lite')
      ? text("Sorry, I can't help with that.")
      : text(`Full answer with thinking ${body.generationConfig?.thinkingConfig?.thinkingLevel}`),
  );
  const res = await new GeminiChatProvider(g.api).create({ messages: [{ role: 'user', content: 'q' }], score: 2 });
  assert.equal(res.choices[0]!.message.content, 'Full answer with thinking low');
  const weak = (content: string | null, finish = 'STOP'): ChatResponse => ({
    choices: [{ finish_reason: finish, message: { content } }],
  });
  assert.ok(isWeakAnswer(weak(''), 5));
  assert.ok(isWeakAnswer(weak('Partial', 'MAX_TOKENS'), 5));
  assert.ok(isWeakAnswer(weak('Yes.'), 9)); // too thin for a hard question
  assert.ok(!isWeakAnswer(weak('Yes.'), 2));
  assert.ok(
    !isWeakAnswer(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }],
            },
          },
        ],
      },
      9,
    ),
  );
});

test('gives up after the attempt limit; returns a weak answer rather than nothing; rate limits try another model', async () => {
  const allRefuse = gemini(() => text("I'm sorry, I can't do that."));
  const res = await new GeminiChatProvider(allRefuse.api).create({
    messages: [{ role: 'user', content: 'q' }],
    score: 5,
  });
  assert.match(res.choices[0]!.message.content!, /sorry/);
  assert.equal(allRefuse.used.length, GEMINI.maxAttemptsPerRequest);

  const limited = gemini((model) =>
    model === 'gemini-3.8-flash'
      ? response(429, { error: { message: 'Resource exhausted' } })
      : text(`ok from ${model}`),
  );
  assert.equal(
    (await new GeminiChatProvider(limited.api).create({ messages: [{ role: 'user', content: 'q' }], score: 6 }))
      .choices[0]!.message.content,
    'ok from gemini-3.5-flash', // another model at the same level, with its own quota,
  );

  const bad = gemini(() => response(401, { error: { message: 'API key not valid' } }));
  await assert.rejects(
    new GeminiChatProvider(bad.api).create({ messages: [{ role: 'user', content: 'q' }], score: 5 }),
    /API key not valid/,
  );
});

test('a model that rejects the thinking setting is retried without it, and remembered', async () => {
  const g = gemini((model, body) =>
    body.generationConfig
      ? response(400, { error: { message: 'Thinking level is not supported for this model' } })
      : text('fine'),
  );
  const router = new GeminiChatProvider(g.api);
  await router.create({ messages: [{ role: 'user', content: 'q' }], score: 2 });
  await router.create({ messages: [{ role: 'user', content: 'q' }], score: 2 });
  assert.deepEqual(
    g.used.map((u) => u.thinking),
    ['low', undefined, undefined],
  );
});

test('agent rates each request and passes the score; Groq never receives it', async () => {
  const seen: number[] = [];
  const spy = {
    name: 'spy',
    create: async (req: { score?: number }) => (seen.push(req.score!), reply({ content: 'ok' })),
  };
  const agent = new ChatAgent({
    providers: [spy],
    tools: buildToolRegistry({ market: fakeMarket }),
    history: new ConversationHistory(6),
    maxToolSteps: 3,
    timezone: 'UTC',
    rater: { rate: async () => ({ score: 9, source: 'ai' }) },
  });
  await agent.ask('c', 'deep question');
  assert.deepEqual(seen, [9]);

  const { client, requests } = fakeChatClient([reply({ content: 'ok' })]);
  await new OpenAICompatibleProvider({ client, model: 'm' }).create({
    messages: [{ role: 'user', content: 'x' }],
    score: 9,
  });
  assert.equal('score' in requests[0], false);
});

// ── Timeouts, exclusions, older models ───────────────────────────────────────

test('older models with a revision number are in the catalog, ranked by version', () => {
  assert.deepEqual(classifyModel('gemini-2.0-flash-001'), {
    name: 'gemini-2.0-flash-001',
    tier: 'flash',
    version: 2.000001,
    alias: false,
  });
  assert.equal(classifyModel('gemini-flash-001'), null);
  const catalog = ModelCatalog.fromNames([
    'gemini-2.0-flash-001',
    'gemini-2.5-flash',
    'gemini-3.8-flash',
    'gemini-2.0-flash-lite-001',
  ]);
  assert.deepEqual(
    catalog.models('flash').map((m) => m.name),
    ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash-001'],
  );
  assert.deepEqual(
    catalog.models('lite').map((m) => m.name),
    ['gemini-2.0-flash-lite-001'],
  );
});

test('GEMINI_EXCLUDE_MODELS removes models by name or prefix*', async () => {
  assert.deepEqual(isExcluded('gemini-2.0-flash-001', ['gemini-2.0-*']), true);
  assert.deepEqual(isExcluded('gemini-3.8-flash', ['gemini-3.8-flash-lite']), false);
  const f = fakeFetch(() => listing());
  const catalog = await new GeminiApi('k', f.fetchImpl, undefined, [
    'gemini-3.8-flash',
    'gemini-flash-lite-*',
  ]).catalog();
  assert.deepEqual(
    catalog.all.map((m) => m.name),
    ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.1-pro'],
  );
  const config = makeConfig({ GEMINI_EXCLUDE_MODELS: 'gemini-3.8-flash, gemini-2.0-*' });
  assert.deepEqual(config.gemini.excludeModels, ['gemini-3.8-flash', 'gemini-2.0-*']);
});

test('a timeout once = short rest; twice within a day = removed for 24h, at that thinking level only', async () => {
  let now = 0;
  const health = new ModelHealth(() => now);
  const g = gemini((model, body) =>
    model === 'gemini-3.8-flash' && body.generationConfig?.thinkingConfig?.thinkingLevel === 'high'
      ? timeout()
      : text(`answer from ${model}, with a full explanation of the analysis`),
  );
  const router = new GeminiChatProvider(g.api, { health, now: () => now });
  const ask = () => router.create({ messages: [{ role: 'user', content: 'analyze' }], score: 8 });
  const res = await ask();
  // After a timeout the next try uses less thinking (faster), not another slow high-thinking model.
  assert.equal(
    res.choices[0]!.message.content,
    'answer from gemini-3.8-flash, with a full explanation of the analysis',
  );
  assert.deepEqual(g.used, [
    { model: 'gemini-3.8-flash', thinking: 'high' },
    { model: 'gemini-3.8-flash', thinking: 'low' },
  ]);
  assert.equal(health.isResting('gemini-3.8-flash', 'high'), true);
  assert.equal(health.isResting('gemini-3.8-flash', 'low'), false);
  now = GEMINI.cooldownMs.busy; // first timeout: back after 10 minutes
  assert.equal(health.isResting('gemini-3.8-flash', 'high'), false);
  await ask(); // times out again
  now += GEMINI.cooldownMs.timeout - 1;
  assert.equal(health.isResting('gemini-3.8-flash', 'high'), true); // second strike: a full day
  now += 1;
  assert.equal(health.isResting('gemini-3.8-flash', 'high'), false);
});

test('hedging: a slow model gets a faster one asked in parallel; the first answer wins and the slow one is cancelled', async () => {
  const health = new ModelHealth();
  const cancelled: string[] = [];
  const f = fakeFetch(async (url, init) => {
    if (url.includes('/models?')) return listing();
    const model = /models\/([^:]+):/.exec(url)![1]!;
    if (model === 'gemini-3.8-flash')
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          cancelled.push(model);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    return text(`quick answer from ${model}`);
  });
  const router = new GeminiChatProvider(new GeminiApi('k', f.fetchImpl), { health, hedgeAfterMs: 5 });
  const res = await router.create({ messages: [{ role: 'user', content: 'what is in this chart?' }], score: 6 });
  assert.equal(res.choices[0]!.message.content, 'quick answer from gemini-3.5-flash-lite');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(cancelled, ['gemini-3.8-flash']);
  // The loser rests 10 minutes (faster models go first), but it's not a strike toward the 24h removal.
  assert.equal(health.isResting('gemini-3.8-flash', 'low'), true);
  assert.equal(health.resting().length, 1);
});

test('model health survives a restart through its store; expired entries are dropped; clear() resets', () => {
  let saved: Record<string, number> = {};
  const store = { load: () => saved, save: (e: Record<string, number>) => void (saved = { ...e }) };
  const first = new ModelHealth(() => 1_000, store);
  first.rest('gemini-3.1-pro', 'timeout', 'high');
  first.rest('gemini-3.5-flash', 'busy');
  assert.deepEqual(Object.keys(saved).sort(), ['gemini-3.1-pro|high', 'gemini-3.5-flash']);
  const later = new ModelHealth(() => 1_000 + GEMINI.cooldownMs.busy + 1, store);
  assert.equal(later.isResting('gemini-3.1-pro', 'high'), true);
  assert.equal(later.isResting('gemini-3.5-flash'), false);
  assert.deepEqual(
    later.resting().map((r) => r.key),
    ['gemini-3.1-pro|high'],
  );
  later.clear();
  assert.deepEqual(saved, {});
});

test('JSON health file: round trip, and a missing or broken file starts empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const store = new JsonFileHealthStore(join(dir, 'sub', 'h.json'));
  assert.deepEqual(store.load(), {});
  store.save({ 'gemini-3.1-pro|high': 123 });
  assert.deepEqual(store.load(), { 'gemini-3.1-pro|high': 123 });
  writeFileSync(join(dir, 'bad.json'), '{oops');
  assert.deepEqual(new JsonFileHealthStore(join(dir, 'bad.json')).load(), {});
});

// ── Pictures ─────────────────────────────────────────────────────────────────

test('pictures: Gemini gets inline data, Groq gets a text note, history keeps a marker, score is at least 4', async () => {
  const image = { mimeType: 'image/png', data: 'iVBORw0K' };
  const body = toGeminiRequest({ messages: [{ role: 'user', content: 'what is this?', images: [image] }] });
  assert.deepEqual(body.contents[0]!.parts, [{ inlineData: image }, { text: 'what is this?' }]);

  const { client, requests } = fakeChatClient([reply({ content: "I can't see pictures right now" })]);
  await new OpenAICompatibleProvider({ client, model: 'm' }).create({
    messages: [{ role: 'user', content: 'what is this?', images: [image] }],
  });
  const sent = requests[0].messages[0];
  assert.equal('images' in sent, false);
  assert.match(sent.content, /can't see pictures[\s\S]*what is this\?$/);

  const seen: { score?: number; images?: unknown }[] = [];
  const spy = {
    name: 'spy',
    create: async (req: any) => (
      seen.push({ score: req.score, images: req.messages.at(-1).images }),
      reply({ content: 'A chart' })
    ),
  };
  const history = new ConversationHistory(6);
  const agent = new ChatAgent({
    providers: [spy],
    tools: buildToolRegistry({ market: fakeMarket }),
    history,
    maxToolSteps: 3,
    timezone: 'UTC',
    rater: { rate: async () => ({ score: 1, source: 'ai' }) },
  });
  await agent.ask('c', 'what is this?', { images: [image] });
  assert.equal(seen[0]!.score, 4);
  const hard = new ChatAgent({
    providers: [spy],
    tools: buildToolRegistry({ market: fakeMarket }),
    history,
    maxToolSteps: 3,
    timezone: 'UTC',
    rater: { rate: async () => ({ score: 9, source: 'ai' }) },
  });
  await hard.ask('c', 'deep analysis of this chart', { images: [image] });
  assert.equal(seen[1]!.score, 6); // pictures never go to high thinking
  assert.deepEqual(seen[0]!.images, [image]);
  assert.equal(history.get('c')[0]!.content, '[sent a picture] what is this?');
});

test('Gemini 4 codenames: Hydrogen → Flash tier (first, newest), Argon → Pro; previews allowed from v4; unknown codenames skipped', () => {
  assert.equal(classifyModel('gemini-4-hydrogen')?.tier, 'flash');
  assert.equal(classifyModel('gemini-4-hydrogen-preview')?.tier, 'flash');
  assert.equal(classifyModel('gemini-4-argon')?.tier, 'pro');
  assert.equal(classifyModel('gemini-4-flash-preview')?.tier, 'flash');
  assert.equal(classifyModel('gemini-4-carbon'), null); // restricted, not mapped
  assert.equal(classifyModel('gemini-4-hydrogen-tts'), null);
  assert.equal(classifyModel('gemini-3.9-flash-preview'), null); // older previews still skipped
  const catalog = ModelCatalog.fromNames([
    ...MODELS,
    'gemini-4-hydrogen-preview',
    'gemini-4-hydrogen',
    'gemini-4-argon',
  ]);
  assert.deepEqual(
    catalog.models('flash').map((m) => m.name),
    ['gemini-4-hydrogen', 'gemini-4-hydrogen-preview', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest'],
  );
  assert.equal(catalog.models('pro')[0]!.name, 'gemini-4-argon');
  // A brand-new name pinned with GEMINI_MODEL is used even if unknown, when the key has it.
  const pinned = ModelCatalog.fromNames([...MODELS, 'gemini-4-helium'], [], 'gemini-4-helium');
  assert.equal(pinned.all.find((m) => m.name === 'gemini-4-helium')?.tier, 'flash');
  assert.equal(
    ModelCatalog.fromNames(MODELS, [], 'gemini-4-helium').all.some((m) => m.name === 'gemini-4-helium'),
    false,
  );
});

// ── Free-tier quota ──────────────────────────────────────────────────────────

test('quota: per-minute and per-day limits, daily reset at midnight Pacific, saved across restarts', () => {
  let now = Date.parse('2026-11-14T10:00:00Z'); // 02:00 in California
  let saved: { day?: string; counts?: Record<string, number> } = {};
  const store = { load: () => saved, save: (s: { day: string; counts: Record<string, number> }) => void (saved = s) };
  const limits = { 'gemini-3.8-flash': { rpm: 2, rpd: 3 }, 'gemini-3.1-pro': { rpm: 0, rpd: 0 } };
  const quota = new QuotaTracker(limits, () => now, store);
  assert.equal(quota.hasRoom('gemini-3.1-pro'), false); // not on the free tier
  assert.equal(quota.hasRoom('gemini-unknown'), true); // no known limit
  quota.record('gemini-3.8-flash');
  quota.record('gemini-3.8-flash');
  assert.equal(quota.hasRoom('gemini-3.8-flash'), false); // 2 per minute
  now += 61_000;
  assert.equal(quota.hasRoom('gemini-3.8-flash'), true);
  quota.record('gemini-3.8-flash');
  assert.equal(quota.left('gemini-3.8-flash'), 0);
  now += 61_000;
  assert.equal(quota.hasRoom('gemini-3.8-flash'), false); // 3 per day
  assert.equal(new QuotaTracker(limits, () => now, store).hasRoom('gemini-3.8-flash'), false); // after a restart
  now = Date.parse('2026-11-15T08:01:00Z'); // just after midnight in California
  assert.equal(quota.hasRoom('gemini-3.8-flash'), true);
  assert.equal(quotaDay(now), '2026-11-15');
});

test('router skips models with no free quota left (no wasted call); a daily 429 uses the model up for today', async () => {
  const g = gemini((model) =>
    model === 'gemini-3.8-flash'
      ? response(429, {
          error: {
            message: 'You exceeded your current quota',
            details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
          },
        })
      : text(`ok from ${model}`),
  );
  const quota = new QuotaTracker({ ...GEMINI.freeTierLimits, 'gemini-3.1-pro': { rpm: 0, rpd: 0 } });
  const api = new GeminiApi('k', g.fetchImpl, undefined, [], '', quota);
  const router = new GeminiChatProvider(api);
  const ask = (score: number) => router.create({ messages: [{ role: 'user', content: 'q' }], score });
  assert.equal((await ask(6)).choices[0]!.message.content, 'ok from gemini-3.5-flash');
  assert.equal(quota.hasRoom('gemini-3.8-flash'), false); // daily quota gone until midnight Pacific
  g.used.length = 0;
  await ask(10); // Pro has no free quota: skipped without a call
  assert.equal(
    g.used.some((u) => u.model === 'gemini-3.1-pro'),
    false,
  );
  // A per-minute 429 only blocks the model for a minute.
  const minute = new QuotaTracker(GEMINI.freeTierLimits);
  minute.exhaustMinute('gemini-3.5-flash-lite');
  assert.equal(minute.hasRoom('gemini-3.5-flash-lite'), false);
  assert.equal(minute.left('gemini-3.5-flash-lite'), 500);
});

test('429 classification: "limit: 0" = not on this key; other free-tier 429s are only temporary', () => {
  assert.equal(
    classifyFailure(429, { error: { message: 'Quota exceeded, limit: 0, model: gemini-3.1-pro' } }),
    'try-next-model',
  );
  assert.equal(
    classifyFailure(429, { error: { message: 'Quota exceeded for metric FreeTier requests, limit: 20' } }),
    'rate-limited',
  );
  assert.equal(
    quotaScope({ error: { message: 'x', status: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' } }),
    'day',
  );
  assert.equal(quotaScope({ error: { message: 'retry in 30s' } }), 'minute');
});

test('the model that answered the previous step is asked first; a pinned model that answers slowly steps aside', async () => {
  let now = 0;
  const health = new ModelHealth(() => now);
  const g = gemini(
    (model) => {
      if (model === 'gemini-4-hydrogen') now += 20_000; // slow
      return text(`answer from ${model}`);
    },
    [...MODELS, 'gemini-4-hydrogen'],
  );
  const router = new GeminiChatProvider(g.api, { health, model: 'gemini-4-hydrogen', now: () => now });
  const ask = (preferModel?: string) =>
    router.create({ messages: [{ role: 'user', content: 'q' }], score: 2, ...(preferModel ? { preferModel } : {}) });
  assert.equal((await ask()).model, 'gemini-4-hydrogen'); // pinned goes first...
  assert.equal(health.isResting('gemini-4-hydrogen', 'low'), true); // ...but it was slow: it steps aside
  assert.equal((await ask()).model, 'gemini-3.5-flash-lite');
  assert.equal((await ask('gemini-3.1-pro')).model, 'gemini-3.1-pro'); // the previous step's model first
});
