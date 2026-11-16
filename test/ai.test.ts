import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProviders } from '../src/app/container.js';
import { GeminiApi } from '../src/adapters/llm/gemini/gemini-api.js';
import { GeminiChatProvider } from '../src/adapters/llm/gemini/gemini-chat-provider.js';
import { fromGeminiResponse, toGeminiRequest } from '../src/adapters/llm/gemini/gemini-mapping.js';
import { OpenAICompatibleProvider } from '../src/adapters/llm/openai-provider.js';
import { extractYouTubeId } from '../src/core/text/youtube-link.js';
import { YouTubeVideoService, looksLikeRefusal } from '../src/adapters/youtube/youtube-video-service.js';
import { GEMINI } from '../src/config/constants.js';
import { systemPrompt } from '../src/config/prompts.js';
import { AiProviderError } from '../src/core/errors.js';
import type { ChatProvider } from '../src/core/types.js';
import { ChatAgent } from '../src/services/agent/chat-agent.js';
import { TOOL, buildToolRegistry } from '../src/services/agent/tool-registry.js';
import { ConversationHistory } from '../src/services/conversation/history.js';
import { fakeChatClient, fakeFetch, fakeMarket, httpError, makeConfig, reply, response, toolCall } from './helpers.js';

const tools = buildToolRegistry({ market: fakeMarket });
const groq = (
  client: ReturnType<typeof fakeChatClient>['client'],
  extra: { fallbackModel?: string; reasoningEffort?: string } = {},
) => new OpenAICompatibleProvider({ client, model: 'primary-model', name: 'groq', ...extra });
const agentWith = (providers: ChatProvider[], extra: Partial<ConstructorParameters<typeof ChatAgent>[0]> = {}) =>
  new ChatAgent({
    providers,
    tools,
    history: new ConversationHistory(6),
    maxToolSteps: 4,
    timezone: 'Asia/Jerusalem',
    ...extra,
  });

// ── Agent loop ───────────────────────────────────────────────────────────────

test('agent runs tools, feeds results back, keeps only text in history', async () => {
  const { client, requests } = fakeChatClient([
    reply({
      content: null,
      tool_calls: [
        toolCall('c1', TOOL.quote, { symbols: ['aapl'] }),
        toolCall('c2', TOOL.loan, { principal: 200000, annual_rate_pct: 6, years: 30 }),
      ],
    }),
    reply({ content: '**AAPL** is 123.45 USD' }),
  ]);
  const history = new ConversationHistory(6);
  const agent = agentWith([groq(client, { reasoningEffort: 'low' })], { history });
  assert.equal(await agent.ask('chat1', 'apple price and a 200k loan?'), '**AAPL** is 123.45 USD');
  const toolMsgs = requests[1].messages.filter((m: any) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /123\.45/);
  assert.match(toolMsgs[1].content, /"monthlyPayment":1199\.1/);
  assert.equal(requests[0].model, 'primary-model');
  assert.equal(requests[0].reasoning_effort, 'low');
  assert.deepEqual(
    history.get('chat1').map((t) => t.role),
    ['user', 'assistant'],
  );
});

test('backup model on 429 (without reasoning_effort); auth errors are not hidden', async () => {
  const limited = fakeChatClient([httpError(429), reply({ content: 'hi' })]);
  assert.equal(
    await agentWith([groq(limited.client, { fallbackModel: 'backup-model', reasoningEffort: 'low' })]).ask(
      'c',
      'hello',
    ),
    'hi',
  );
  assert.equal(limited.requests[1].model, 'backup-model');
  assert.equal(limited.requests[1].reasoning_effort, undefined);

  const bad = fakeChatClient([httpError(401, 'bad key')]);
  await assert.rejects(
    agentWith([groq(bad.client, { fallbackModel: 'backup-model' })]).ask('c', 'hello'),
    (e) => e instanceof AiProviderError && e.status === 401,
  );
});

test('bad tool JSON and unknown tools are reported to the AI; stops after maxToolSteps', async () => {
  const loop = () =>
    reply({ content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'nope', arguments: '{bad' } }] });
  const { client, requests } = fakeChatClient([
    loop,
    loop,
    reply({ content: '', tool_calls: [toolCall('y', 'nope', {})] }),
    loop,
    reply({ content: 'final' }),
  ]);
  assert.equal(await agentWith([groq(client)]).ask('c', 'loop forever'), 'final');
  assert.equal(requests.length, 5);
  assert.equal(requests[4].tool_choice, 'none');
  const toolMsgs: string[] = requests[4].messages
    .filter((m: any) => m.role === 'tool')
    .map((m: any) => m.content as string);
  assert.ok(toolMsgs.some((c) => c.includes('not valid JSON')));
  assert.ok(toolMsgs.some((c) => c.includes('Unknown tool')));
});

test('group: sender name in the prompt and history; echoed name prefix removed', async () => {
  const { client, requests } = fakeChatClient([reply({ content: 'one' }), reply({ content: 'Amir: two' })]);
  const agent = agentWith([groq(client)]);
  await agent.ask('g1', 'first', { senderName: 'Amir' });
  assert.equal(await agent.ask('g1', 'and in euros?', { senderName: 'Amir' }), 'two');
  const msgs = requests[1].messages;
  assert.equal(msgs[1].content, 'Amir: first');
  assert.equal(msgs[2].content, 'one');
  assert.equal(msgs.at(-1).content, 'Amir: and in euros?');
});

test('forceTool makes only the first step call that tool', async () => {
  const video = { enabled: true, ask: async () => ({ videoUrl: 'u', model: 'm', answer: 'video summary' }) };
  const { client, requests } = fakeChatClient([
    reply({ content: null, tool_calls: [toolCall('y1', TOOL.video, { url: 'https://youtu.be/dQw4w9WgXcQ' })] }),
    reply({ content: 'Here is the summary' }),
  ]);
  const agent = agentWith([groq(client)], { tools: buildToolRegistry({ market: fakeMarket, video }) });
  await agent.ask('c', 'summarize https://youtu.be/dQw4w9WgXcQ', { forceTool: TOOL.video });
  assert.deepEqual(requests[0].tool_choice, { type: 'function', function: { name: TOOL.video } });
  assert.equal(requests[1].tool_choice, 'auto');
});

test('summarize: one call, no tools, headlines (no links) in the prompt', async () => {
  const { client, requests } = fakeChatClient([reply({ content: '*Markets*\n*Mood:* mixed' })]);
  const text = await agentWith([groq(client)]).summarize({
    topic: 'Global markets',
    language: 'Hebrew',
    items: [{ title: 'Nvidia falls', source: 'Reuters', publishedAt: '2026-11-12T10:00:00.000Z', url: 'https://x' }],
  });
  assert.match(text, /Mood/);
  assert.equal(requests[0].tools, undefined);
  assert.match(requests[0].messages[0].content, /Write in Hebrew/);
  assert.match(requests[0].messages[1].content, /- Nvidia falls \(Reuters, 2026-11-12 10:00 UTC\)/);
  assert.doesNotMatch(requests[0].messages[1].content, /https:\/\/x/);
});

test('system prompt: general-purpose; owner rules first and REPLY_LANGUAGE override the default language rule', () => {
  const now = new Date('2026-11-12T20:00:00Z');
  const auto = systemPrompt({ now, timeZone: 'UTC' });
  assert.match(auto, /like ChatGPT or Gemini/);
  assert.match(auto, /language of the user's LATEST message/);
  const p = systemPrompt({
    now,
    timeZone: 'Asia/Jerusalem',
    ownerRules: 'answer only in english',
    replyLanguage: 'English',
  });
  assert.match(p, /ALWAYS reply in English/);
  assert.doesNotMatch(p, /LATEST message/);
  assert.ok(p.indexOf('answer only in english') < p.indexOf('How to answer'));
});

test('tool registry: news and video tools only when available', () => {
  assert.ok(!tools.names.includes(TOOL.video));
  assert.ok(!tools.names.includes(TOOL.news));
  const all = buildToolRegistry({
    market: fakeMarket,
    news: { getNews: async () => ({ topic: '', items: [], source: '' }) },
    video: { enabled: true, ask: async () => ({ videoUrl: '', model: '', answer: '' }) },
  });
  assert.ok(all.names.includes(TOOL.video) && all.names.includes(TOOL.news));
  assert.ok(
    !buildToolRegistry({
      market: fakeMarket,
      video: { enabled: false, ask: async () => ({ videoUrl: '', model: '', answer: '' }) },
    }).names.includes(TOOL.video),
  );
});

// ── Gemini ───────────────────────────────────────────────────────────────────

test('toGeminiRequest: system, turns, tools, forced tool, signatures, grouped responses', () => {
  const body = toGeminiRequest({
    messages: [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'price of AAPL and MSFT?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            ...toolCall('a', TOOL.quote, { symbols: ['AAPL'] }),
            extra_content: { google: { thought_signature: 'SIG1', function_call_id: 'g1' } },
          },
          toolCall('b', TOOL.quote, { symbols: ['MSFT'] }),
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: '[{"symbol":"AAPL","price":1}]' },
      { role: 'tool', tool_call_id: 'b', content: 'not json' },
    ],
    tools: [...tools.schemas],
    tool_choice: { type: 'function', function: { name: TOOL.quote } },
  });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be helpful.' }] });
  assert.equal(body.contents.length, 3);
  assert.deepEqual(body.contents[1]!.parts[0], {
    functionCall: { name: TOOL.quote, args: { symbols: ['AAPL'] }, id: 'g1' },
    thoughtSignature: 'SIG1',
  });
  assert.equal(body.contents[1]!.parts[1]!.thoughtSignature, undefined);
  assert.deepEqual(body.contents[2]!.parts[0]!.functionResponse, {
    name: TOOL.quote,
    response: { result: [{ symbol: 'AAPL', price: 1 }] },
    id: 'g1',
  });
  assert.deepEqual(body.contents[2]!.parts[1]!.functionResponse!.response, { result: 'not json' });
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL.quote] } });
  assert.equal(body.generationConfig, undefined);
});

test('tool calls made by the backup AI get the documented skip signature', () => {
  const body = toGeminiRequest({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [toolCall('x', TOOL.news, {})] },
      { role: 'tool', tool_call_id: 'x', content: '{}' },
    ],
  });
  assert.equal(body.contents[1]!.parts[0]!.thoughtSignature, GEMINI.skipThoughtSignature);
});

test('fromGeminiResponse: text, function calls with signatures, skips thoughts, blocked prompts', () => {
  const r = fromGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            { text: 'reasoning', thought: true },
            { functionCall: { name: TOOL.quote, args: { symbols: ['NVDA'] }, id: 'fc9' }, thoughtSignature: 'SIG' },
          ],
        },
      },
    ],
  });
  const msg = r.choices[0]!.message;
  assert.equal(msg.content, null);
  assert.equal(msg.tool_calls![0]!.id, 'fc9');
  assert.equal(msg.tool_calls![0]!.extra_content!.google!.thought_signature, 'SIG');
  assert.throws(() => fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /blocked: SAFETY/);
});

function fakeGemini(handler: (model: string, body: any, n: number) => Response) {
  let n = 0;
  return fakeFetch((url, init) => {
    if (url.includes('/models?')) {
      return response(200, {
        models: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash'].map((m) => ({
          name: `models/${m}`,
          supportedGenerationMethods: ['generateContent'],
        })),
      });
    }
    if (url.includes('/oembed')) return response(200, { title: 'Market outlook', author_name: 'Some Channel' });
    const model = /models\/([^:]+):/.exec(url)![1]!;
    return handler(model, JSON.parse(init.body as string), ++n);
  });
}
const geminiText = (text: string) => response(200, { candidates: [{ content: { parts: [{ text }] } }] });
const busy = () => response(503, { error: { message: 'This model is currently experiencing high demand.' } });

test('Gemini end to end: tool call with signature, then the answer', async () => {
  const g = fakeGemini((model, body, n) => {
    if (n === 1)
      return response(200, {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: TOOL.quote, args: { symbols: ['AAPL'] } }, thoughtSignature: 'S1' }],
            },
          },
        ],
      });
    assert.equal(body.contents[1].parts[0].thoughtSignature, 'S1');
    assert.match(JSON.stringify(body.contents[2]), /123\.45/);
    return geminiText('AAPL is *123.45 USD*');
  });
  const provider = new GeminiChatProvider(new GeminiApi('AQ.key', g.fetchImpl));
  assert.equal(await agentWith([provider]).ask('c', 'apple price?'), 'AAPL is *123.45 USD*');
  const generate = g.calls.find((c) => c.url.includes(':generateContent'))!;
  assert.equal((generate.init.headers as Record<string, string>)['x-goog-api-key'], 'AQ.key');
  assert.match(generate.url, /gemini-3\.8-flash:generateContent$/); // versioned before the busy alias
});

test('buildProviders follows MAIN_AI', () => {
  const names = (env: Record<string, string>) =>
    buildProviders(makeConfig(env), undefined, { openAIClient: fakeChatClient([]).client }).map((p) => p.name);
  assert.deepEqual(names({ MAIN_AI: 'gemini', GEMINI_API_KEY: 'AQ.x' }), ['gemini', 'groq']);
  assert.deepEqual(names({ MAIN_AI: 'groq', GEMINI_API_KEY: 'AQ.x' }), ['groq', 'gemini']);
  assert.deepEqual(names({ MAIN_AI: 'gemini', GEMINI_API_KEY: 'AQ.x', LLM_API_KEY: '' }), ['gemini']);
});

// ── YouTube ──────────────────────────────────────────────────────────────────

const ID = 'dQw4w9WgXcQ';

test('extractYouTubeId understands every common link format', () => {
  for (const link of [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?feature=share&v=${ID}&t=42`,
    `https://youtu.be/${ID}?si=abc`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?si=x`,
    `check this https://youtu.be/${ID} 🔥`,
  ]) {
    assert.equal(extractYouTubeId(link), ID, link);
  }
  assert.equal(extractYouTubeId('https://vimeo.com/123'), null);
  assert.equal(extractYouTubeId(`https://youtu.be/${ID}EXTRA`), null);
});

const videoService = (handler: Parameters<typeof fakeGemini>[0], language = '') => {
  const g = fakeGemini(handler);
  return {
    service: new YouTubeVideoService(new GeminiApi('AQ.key', g.fetchImpl), {
      fps: 0.5,
      language,
      fetchImpl: g.fetchImpl,
    }),
    calls: g.calls,
  };
};

test('video: link sent as file_data with fps; title from oEmbed; answers cached', async () => {
  const { service, calls } = videoService((model) => geminiText(`Summary by ${model}`), 'English');
  const r = await service.ask(`https://youtu.be/${ID}?si=x`, 'what does he say about NVDA?');
  assert.equal(r.answer, 'Summary by gemini-3.8-flash');
  assert.equal(r.title, 'Market outlook');
  const gen = calls.find((c) => c.url.includes(':generateContent'))!;
  assert.equal(gen.body.contents[0].parts[0].file_data.file_uri, `https://www.youtube.com/watch?v=${ID}`);
  assert.deepEqual(gen.body.contents[0].parts[0].video_metadata, { fps: 0.5 });
  assert.match(gen.body.contents[0].parts[1].text, /Request: what does he say about NVDA\?[\s\S]*Write in English/);
  await service.ask(`https://www.youtube.com/watch?v=${ID}`, 'what does he say about NVDA?');
  assert.equal(calls.filter((c) => c.url.includes(':generateContent')).length, 1);
});

test('video: busy / unavailable / refusing models are skipped; fps retried without metadata', async () => {
  const { service } = videoService((m) =>
    m === 'gemini-flash-latest'
      ? busy()
      : m === 'gemini-3.8-flash'
        ? geminiText("I'm sorry, I can't watch videos.")
        : geminiText('Real summary'),
  );
  const r = await service.ask(`https://youtu.be/${ID}`);
  assert.equal(r.model, 'gemini-3.5-flash');
  assert.equal(r.answer, 'Real summary');

  const fps = videoService((_m, body) =>
    body.contents[0].parts[0].video_metadata
      ? response(400, { error: { message: 'Invalid video_metadata' } })
      : geminiText('plain ok'),
  );
  assert.equal((await fps.service.ask(`https://youtu.be/${ID}`)).answer, 'plain ok');
});

test('video: clear errors for all-busy, rate limits, bad keys and missing key', async () => {
  await assert.rejects(
    videoService(() => busy()).service.ask(`https://youtu.be/${ID}`),
    /All free Gemini models are busy/,
  );
  await assert.rejects(
    videoService(() => response(429, { error: { message: 'retry in 30s' } })).service.ask(`https://youtu.be/${ID}`),
    /free Gemini limit is used up/,
  );
  await assert.rejects(
    videoService(() => response(401, { error: { message: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' } })).service.ask(
      `https://youtu.be/${ID}`,
    ),
    /rejected the API key \(HTTP 401: ACCESS_TOKEN_TYPE_UNSUPPORTED\)/,
  );
  const off = new YouTubeVideoService(new GeminiApi(''));
  assert.equal(off.enabled, false);
  await assert.rejects(off.ask(`https://youtu.be/${ID}`), /GEMINI_API_KEY/);
});

test('looksLikeRefusal', () => {
  assert.ok(looksLikeRefusal("I'm sorry, but I can't watch videos or access YouTube links."));
  assert.ok(looksLikeRefusal('عذرًا، لا أستطيع مشاهدة الفيديو'));
  assert.ok(!looksLikeRefusal('The speaker explains why he cannot see a recession coming. Key points: ...'.repeat(10)));
});
