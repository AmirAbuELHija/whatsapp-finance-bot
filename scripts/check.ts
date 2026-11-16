/**
 * Health check: tests the AI keys and (optionally) one YouTube video, without printing secrets.
 *   npm run check
 *   npm run check -- https://youtu.be/VIDEO_ID
 *   npm run check -- --probe          times every Gemini model and suggests GEMINI_EXCLUDE_MODELS
 *   npm run check -- --reset-health   puts every timed-out model back in rotation
 */
import { buildProviders, buildRater, createGeminiShared } from '../src/app/container.js';
import { loadEnvFile } from '../src/app/load-env.js';
import { GeminiChatProvider } from '../src/adapters/llm/gemini/gemini-chat-provider.js';
import { GEMINI } from '../src/config/constants.js';
import type { GeminiApi } from '../src/adapters/llm/gemini/gemini-api.js';
import { classifyFailure } from '../src/adapters/llm/gemini/gemini-api.js';
import type { ModelCatalog } from '../src/adapters/llm/gemini/gemini-models.js';
import { YouTubeVideoService } from '../src/adapters/youtube/youtube-video-service.js';
import { configProblems, loadConfig } from '../src/config/env.js';
import { messageOf, statusOf } from '../src/core/errors.js';
import { silentLogger } from '../src/core/logger.js';
import type { Logger } from '../src/core/types.js';

const mask = (key: string) => (key ? `${key.slice(0, 3)}… (${key.length} chars)` : '(empty)');
const line = (ok: boolean, text: string) => {
  console.log(`${ok ? '✅' : '❌'} ${text}`);
};
const seconds = (start: number) => `${((Date.now() - start) / 1000).toFixed(1)}s`;
const verbose: Logger = {
  ...silentLogger,
  info: (o: object | string, m?: string) => {
    console.log(`   ℹ️  ${m ?? ''} ${JSON.stringify(o)}`);
  },
  warn: (o: object | string, m?: string) => {
    console.log(`   ⚠️  ${m ?? ''} ${JSON.stringify(o)}`);
  },
};

interface ProbeResult {
  model: string;
  ok: boolean;
  ms: number;
  note: string;
  /** Slow or not available on this key: worth excluding. Busy / rate limits / network errors are temporary. */
  exclude: boolean;
}

/** One tiny request per model, all at once (each model has its own quota). */
async function probe(api: GeminiApi, catalog: ModelCatalog): Promise<ProbeResult[]> {
  return Promise.all(
    // Models with no free quota left are skipped (they would only fail).
    catalog.all
      .filter((m) => api.quota.hasRoom(m.name))
      .map(async ({ name }): Promise<ProbeResult> => {
        const start = Date.now();
        try {
          const res = await api.generate(
            name,
            {
              contents: [{ role: 'user', parts: [{ text: 'Reply with just the word OK.' }] }],
              generationConfig: { maxOutputTokens: 256, temperature: 0 },
            },
            GEMINI.probeTimeoutMs,
          );
          const ms = Date.now() - start;
          if (res.ok) return { model: name, ok: true, ms, note: '', exclude: false };
          const kind = classifyFailure(res.status, res.body);
          const note =
            kind === 'try-next-model' ? 'not available on your key' : `HTTP ${res.status} (${kind}, temporary)`;
          return { model: name, ok: false, ms, note, exclude: kind === 'try-next-model' };
        } catch (error) {
          const ms = Date.now() - start;
          const timedOut = /timeout|aborted/i.test(String(error));
          return {
            model: name,
            ok: false,
            ms,
            note: timedOut
              ? `too slow: no answer in ${GEMINI.probeTimeoutMs / 1000}s`
              : `network error: ${messageOf(error)}`,
            exclude: timedOut,
          };
        }
      }),
  );
}

async function run(): Promise<number> {
  const envFile = loadEnvFile();
  if (!envFile) console.log('⚠️  No .env file found here (run this from the whatsapp-finance-bot folder)');
  const config = loadConfig();
  const args = process.argv.slice(2);
  const link = args.find((a) => !a.startsWith('--'));
  const wantProbe = args.includes('--probe');
  const resetHealth = args.includes('--reset-health');
  let failures = 0;

  console.log('\n── Settings ──');
  console.log(`Main AI:        ${config.mainAI}`);
  console.log(
    `Groq/LLM:       ${config.llm.model} @ ${new URL(config.llm.baseURL).host}, key ${mask(config.llm.apiKey)}`,
  );
  console.log(`Gemini key:     ${mask(config.gemini.apiKey)}`);
  console.log(`Reply language: ${config.bot.replyLanguage || 'auto (same as the user)'}`);
  console.log(`Owner rules:    ${config.bot.instructions || '(none)'}`);
  console.log(
    `Access:         ${config.access.allowedUsers.length} users, ${config.access.allowedGroups.length} groups, private chats without @bot: ${String(config.access.dmWithoutTrigger)}`,
  );
  for (const problem of configProblems(config)) {
    line(false, problem);
    failures++;
  }

  const gemini = createGeminiShared(config, silentLogger);

  if (config.gemini.apiKey) {
    console.log('\n── Gemini models for your key ──');
    const catalog = await gemini.api.catalog();
    for (const tier of ['lite', 'flash', 'pro'] as const) {
      const names = catalog.models(tier).map((m) => m.name);
      console.log(`${tier.padEnd(6)} ${names.length ? names.join(', ') : '(none)'}`);
    }
    if (config.gemini.excludeModels.length)
      console.log(`excluded by GEMINI_EXCLUDE_MODELS: ${config.gemini.excludeModels.join(', ')}`);

    if (resetHealth) {
      gemini.health.clear();
      console.log('♻️  All resting models are back in rotation');
    }
    const resting = gemini.health.resting();
    console.log('\n── Removed for now (timed out / busy / not on your key) ──');
    if (!resting.length) console.log('(none)');
    for (const r of resting) {
      const [model, thinking] = r.key.split('|');
      console.log(`${model ?? r.key}${thinking ? ` (thinking ${thinking})` : ''} until ${r.until.toLocaleString()}`);
    }
    if (resting.length) console.log('(npm run check -- --reset-health puts them back)');

    if (config.gemini.freeTier) {
      console.log('\n── Free quota used today (counted by the bot, resets at midnight Pacific) ──');
      const listed = new Set(catalog.all.map((m) => m.name));
      for (const u of gemini.api.quota.usage().filter((x) => listed.has(x.model)))
        console.log(`${u.model.padEnd(24)} ${String(u.used).padStart(3)} / ${u.limit.rpd} today, ${u.limit.rpm}/min`);
      console.log('(GEMINI_FREE_TIER=false if you pay for Gemini: the limits above are then ignored)');
    }
    console.log('\n── Routing ladder (score → model) ──');
    const router = new GeminiChatProvider(gemini.api, {
      model: config.gemini.model,
      thinkingLevel: config.gemini.thinkingLevel,
      health: gemini.health,
    });
    for (const band of GEMINI.scoreBands) {
      const first = router.plan(catalog, band.maxScore)[0];
      console.log(
        `score ≤${String(band.maxScore).padEnd(3)} → ${first?.tier ?? '?'} tier: ${first ? `${first.model} (thinking ${first.thinkingLevel || 'default'})` : '(no model)'}`,
      );
    }

    if (wantProbe) {
      console.log(
        `\n── Speed probe (each model, ${GEMINI.probeTimeoutMs / 1000}s limit; uses 1 request of each model's daily quota) ──`,
      );
      const results = (await probe(gemini.api, catalog)).sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
      for (const r of results) line(r.ok, `${r.model.padEnd(28)} ${(r.ms / 1000).toFixed(1).padStart(5)}s ${r.note}`);
      const slow = results.filter((r) => r.exclude).map((r) => r.model);
      if (results.every((r) => !r.ok && !r.exclude)) {
        console.log('\nNo model could be reached: check the internet connection and GEMINI_API_KEY, then try again.');
      } else if (slow.length) {
        const exclude = [...new Set([...config.gemini.excludeModels, ...slow])];
        console.log(
          `\nTo remove the failing models for good, put this line in .env and restart:\nGEMINI_EXCLUDE_MODELS=${exclude.join(',')}`,
        );
      } else {
        console.log(
          results.every((r) => r.ok)
            ? '\nEvery model answered in time 👍'
            : '\nNo slow models. Some were busy right now; that passes on its own.',
        );
      }
    } else {
      console.log('\n(time every model: npm run check -- --probe)');
    }

    console.log(`\n── Pre-rating (${config.routerRating}) ──`);
    const rater = buildRater(config, gemini);
    for (const sample of [
      '@bot price of TEVA?',
      '@bot what is an ETF?',
      '@bot compare NVDA and AMD for a 5 year portfolio, risks and scenarios',
    ]) {
      const start = Date.now();
      const { score, source } = await rater.rate(sample);
      console.log(`${String(score).padStart(2)}/10 (${source}, ${seconds(start)})  ${sample}`);
    }
  }

  console.log('\n── Chat AIs (main first, then backup) ──');
  const providers = buildProviders(config, silentLogger, {}, gemini);
  if (!providers.length) {
    line(false, 'No chat AI configured: set GEMINI_API_KEY and/or LLM_API_KEY');
    failures++;
  }
  for (const [i, provider] of providers.entries()) {
    const role = i === 0 ? 'main' : 'backup';
    const start = Date.now();
    try {
      const res = await provider.create({
        messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
        max_tokens: 200,
        score: 2,
      });
      const model = res.model ?? (provider.name === 'groq' ? config.llm.model : '');
      line(
        true,
        `${provider.name} (${role}${model ? `, ${model}` : ''}) answered "${(res.choices[0]?.message.content ?? '').trim().slice(0, 30)}" in ${seconds(start)}`,
      );
    } catch (error) {
      line(false, `${provider.name} (${role}) failed: HTTP ${statusOf(error) ?? '?'} ${messageOf(error)}`);
      failures++;
    }
  }

  if (config.gemini.apiKey && link) {
    console.log(`\n── YouTube ──\nAsking Gemini about ${link} (can take up to a minute)…`);
    const video = new YouTubeVideoService(gemini.api, {
      model: config.gemini.model,
      fps: config.gemini.youtubeFps,
      language: config.bot.replyLanguage,
      logger: verbose,
    });
    const start = Date.now();
    try {
      const r = await video.ask(link);
      line(true, `Gemini answered in ${seconds(start)} using ${r.model}. Video: ${r.title ?? '(title unknown)'}`);
      console.log(`\n${r.answer.slice(0, 1200)}`);
    } catch (error) {
      line(false, `YouTube failed: ${messageOf(error)}`);
      failures++;
    }
  } else if (config.gemini.apiKey) {
    console.log('\n(add a YouTube link to test a video: npm run check -- https://youtu.be/...)');
  } else {
    line(false, 'GEMINI_API_KEY is empty: Gemini routing and YouTube summaries are off');
  }
  console.log('');
  return failures;
}

try {
  process.exitCode = (await run()) > 0 ? 1 : 0;
} catch (error) {
  console.error(`❌ ${messageOf(error)}`);
  process.exitCode = 1;
}
