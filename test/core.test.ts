import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblems, loadConfig } from '../src/config/env.js';
import { TtlCache } from '../src/core/cache/ttl-cache.js';
import { ConfigError, UserInputError } from '../src/core/errors.js';
import { budget503020, cagr, compoundGrowth, loanPayment, savingsGoal } from '../src/core/finance/calculators.js';
import { ago, parseAmount } from '../src/core/text/format.js';
import { detectScriptLanguage, languageName } from '../src/core/text/language.js';
import { stripNamePrefix } from '../src/core/text/name-prefix.js';
import { parseTrigger } from '../src/core/text/trigger.js';
import { toWhatsApp } from '../src/core/text/whatsapp-markdown.js';

test('compound growth: 1000 at 12% for 1 year = 1126.83 (monthly compounding)', () => {
  const r = compoundGrowth({ principal: 1000, annualRatePct: 12, years: 1 });
  assert.equal(r.finalValue, 1126.83);
  assert.equal(r.totalContributed, 1000);
});

test('compound growth: deposits at 0% and the annuity formula', () => {
  assert.equal(compoundGrowth({ principal: 0, annualRatePct: 0, years: 2, monthlyContribution: 100 }).finalValue, 2400);
  const r = compoundGrowth({ principal: 10000, annualRatePct: 7, years: 20, monthlyContribution: 500 });
  const i = 0.07 / 12;
  const g = (1 + i) ** 240;
  assert.equal(r.finalValue, Math.round((10000 * g + (500 * (g - 1)) / i) * 100) / 100);
  assert.equal(r.finalValueInTodaysMoney, undefined);
  const inflated = compoundGrowth({ principal: 1000, annualRatePct: 5, years: 10, inflationPct: 3 });
  assert.ok(inflated.finalValueInTodaysMoney! < inflated.finalValue!);
});

test('loan: 200,000 at 6% for 30 years = 1199.10/month; 0% splits evenly', () => {
  const r = loanPayment({ principal: 200000, annualRatePct: 6, years: 30 });
  assert.equal(r.monthlyPayment, 1199.1);
  assert.equal(r.months, 360);
  assert.equal(loanPayment({ principal: 1200, annualRatePct: 0, years: 1 }).monthlyPayment, 100);
});

test('savings goal round-trips with compound growth; already on track', () => {
  const g = savingsGoal({ target: 100000, annualRatePct: 6, years: 10, currentSavings: 5000 });
  const check = compoundGrowth({ principal: 5000, annualRatePct: 6, years: 10, monthlyContribution: g.monthlyNeeded! });
  assert.ok(Math.abs(check.finalValue! - 100000) < 5);
  const done = savingsGoal({ target: 1000, annualRatePct: 5, years: 5, currentSavings: 2000 });
  assert.equal(done.alreadyOnTrack, true);
  assert.equal(done.monthlyNeeded, 0);
});

test('cagr and 50/30/20', () => {
  assert.equal(cagr({ startValue: 100, endValue: 200, years: 10 }).cagrPct, 7.18);
  assert.deepEqual(budget503020({ monthlyIncome: 10000 }), { needs50: 5000, wants30: 3000, savings20: 2000 });
});

test('bad calculator inputs throw UserInputError with readable messages', () => {
  assert.throws(
    () => loanPayment({ principal: -5, annualRatePct: 5, years: 10 }),
    (e) => e instanceof UserInputError && /loan amount/.test(e.message),
  );
  assert.throws(() => compoundGrowth({ principal: 1, annualRatePct: Number('abc'), years: 1 }), /annual rate/);
  assert.throws(() => compoundGrowth({ principal: 1, annualRatePct: 5, years: 0 }), /years/);
});

test('parseAmount, toWhatsApp, ago', () => {
  assert.equal(parseAmount('10k'), 10000);
  assert.equal(parseAmount('1.5m'), 1500000);
  assert.equal(parseAmount('50,000'), 50000);
  assert.equal(parseAmount('7%'), 7);
  assert.equal(parseAmount('₪300'), 300);
  assert.ok(Number.isNaN(parseAmount('USD')));
  assert.equal(toWhatsApp('## Title\n**bold** and __it__\n* item'), '*Title*\n*bold* and _it_\n- item');
  assert.equal(ago('2026-11-12T10:00:00Z', Date.parse('2026-11-12T12:30:00Z')), '3h ago');
});

test('parseTrigger: word trigger, mentions, ignores look-alikes', () => {
  assert.equal(parseTrigger('@bot price of AAPL?'), 'price of AAPL?');
  assert.equal(parseTrigger('hey @Bot, how is TSLA'), 'hey how is TSLA');
  assert.equal(parseTrigger('@BOT: /price NVDA'), '/price NVDA');
  assert.equal(parseTrigger('@bot כמה זה 100 דולר בשקלים'), 'כמה זה 100 דולר בשקלים');
  assert.equal(parseTrigger('@bot'), '');
  assert.equal(parseTrigger('what is the price of AAPL'), null);
  assert.equal(parseTrigger('email me at me@bot.com'), null);
  assert.equal(parseTrigger('@botany is fun'), null);
  assert.equal(parseTrigger('!fin loan 100k 5 10', { trigger: '!fin' }), 'loan 100k 5 10');
  const selfIds = ['972501234567:12@s.whatsapp.net', '11122233344:12@lid'];
  assert.equal(
    parseTrigger('@972501234567 convert 50 EUR', { mentionedJids: ['972501234567@s.whatsapp.net'], selfIds }),
    'convert 50 EUR',
  );
  assert.equal(parseTrigger('@11122233344 /price BTC', { mentionedJids: ['11122233344@lid'], selfIds }), '/price BTC');
  assert.equal(parseTrigger('@972509999999 hi', { mentionedJids: ['972509999999@s.whatsapp.net'], selfIds }), null);
});

test('stripNamePrefix removes an echoed "Name:" only at the start', () => {
  assert.equal(stripNamePrefix('Muhammad Natour: מצטער, הנה התשובה', 'Muhammad Natour'), 'מצטער, הנה התשובה');
  assert.equal(stripNamePrefix('*Muhammad Natour:* hi', 'Muhammad Natour'), 'hi');
  assert.equal(stripNamePrefix('⁨Amir⁩: שלום', 'Amir'), 'שלום');
  assert.equal(stripNamePrefix('Amir (C++ dev): keep', 'Amir (C++ dev)'), 'keep');
  assert.equal(stripNamePrefix('Hello Amir: this stays', 'Amir'), 'Hello Amir: this stays');
});

test('language helpers', () => {
  assert.equal(languageName('en'), 'English');
  assert.equal(languageName('auto'), '');
  assert.equal(languageName('french'), 'French');
  assert.equal(detectScriptLanguage('ריבית בנק ישראל'), 'he');
  assert.equal(detectScriptLanguage('أسعار الفائدة'), 'ar');
  assert.equal(detectScriptLanguage('Fed rates'), 'en');
});

test('TtlCache expires and caps entries', () => {
  let now = 0;
  const cache = new TtlCache<number>(1000, 2, () => now);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.get('a'), undefined); // evicted, oldest
  assert.equal(cache.get('c'), 3);
  now = 1500;
  assert.equal(cache.get('c'), undefined); // expired
});

test('loadConfig: defaults, parsing and MAIN_AI selection', () => {
  const c = loadConfig({
    LLM_API_KEY: 'k',
    ALLOWED_USERS: '+972-50-111-1111, 972541112222',
    RATE_LIMIT_PER_MINUTE: '3',
    REPLY_LANGUAGE: 'en',
  });
  assert.deepEqual(c.access.allowedUsers, ['972501111111', '972541112222']);
  assert.equal(c.access.rateLimitPerMinute, 3);
  assert.equal(c.bot.trigger, '@bot');
  assert.equal(c.bot.replyPrefix, '🤖 ');
  assert.equal(c.bot.replyLanguage, 'English');
  assert.equal(c.mainAI, 'groq');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'AQ.x' }).mainAI, 'gemini');
  assert.equal(loadConfig({ LLM_BASE_URL: 'http://localhost:11434/v1' }).llm.apiKey, 'local');
  assert.equal(loadConfig({ LLM_API_KEY: 'k', LLM_BASE_URL: '', LOG_LEVEL: '' }).logLevel, 'info');
});

test('loadConfig reports every invalid setting at once', () => {
  assert.throws(
    () => loadConfig({ MAIN_AI: 'chatgpt', RATE_LIMIT_PER_MINUTE: 'lots', LLM_BASE_URL: 'not a url' }),
    (e) =>
      e instanceof ConfigError &&
      e.problems.length === 3 &&
      /MAIN_AI/.test(e.message) &&
      /RATE_LIMIT_PER_MINUTE/.test(e.message),
  );
});

test('configProblems: the main AI needs its key', () => {
  assert.match(configProblems(loadConfig({ MAIN_AI: 'gemini' }))[0]!, /GEMINI_API_KEY is empty/);
  assert.match(configProblems(loadConfig({ MAIN_AI: 'groq' }))[0]!, /LLM_API_KEY is empty/);
  assert.deepEqual(configProblems(loadConfig({ MAIN_AI: 'gemini', GEMINI_API_KEY: 'AQ.x' })), []);
});
