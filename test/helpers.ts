/** Fakes shared by the tests: HTTP, chat AI, WhatsApp socket, logger, config. */
import type { FetchLike } from '../src/adapters/http/http-client.js';
import type { ChatCompletionsClient } from '../src/adapters/llm/openai-provider.js';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import type { Logger, MarketData, ToolCall, OutgoingFile } from '../src/core/types.js';
import type { RawWhatsAppMessage } from '../src/adapters/whatsapp/message-content.js';
import type { ChatTransport } from '../src/core/types.js';

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function makeConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ LLM_API_KEY: 'test-key', ...env });
}

export function response(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    text: () => Promise.resolve(text),
  } as Response;
}

/** A fetch that records calls and answers through `route`. */
export function fakeFetch(route: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
    return route(url, init);
  };
  return { fetchImpl, calls };
}

export const toolCall = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
export const reply = (message: { content: string | null; tool_calls?: ToolCall[] }) => ({ choices: [{ message }] });

type Step = ReturnType<typeof reply> | Error | ((params: any) => unknown);

/** OpenAI-compatible client that plays back a script of responses and records requests. */
export function fakeChatClient(script: Step[]) {
  const requests: any[] = [];
  const client: ChatCompletionsClient = {
    chat: {
      completions: {
        create: async (params) => {
          requests.push(structuredClone(params));
          const next = script.shift();
          if (next instanceof Error) throw next;
          return typeof next === 'function' ? next(params) : next;
        },
      },
    },
  };
  return { client, requests };
}

export const httpError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

export const fakeMarket: MarketData = {
  getQuote: async (s) => ({
    symbol: s.toUpperCase(),
    name: 'Test Co',
    currency: 'USD',
    price: 123.45,
    previousClose: 122,
    change: 1.45,
    changePct: 1.19,
    dayHigh: null,
    dayLow: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    exchange: null,
    marketTime: null,
    source: 'test',
  }),
  getHistory: async () => {
    throw new Error('not used');
  },
  convertCurrency: async (amount, from, to) => ({ amount, from, to, rate: 3.7, result: amount * 3.7, source: 'test' }),
};

/** A ChatTransport that records what the bot sends. */
export function fakeSocket() {
  const sent: { jid: string; text: string; quoted: string | null | undefined; id: string }[] = [];
  const files: { jid: string; file: OutgoingFile }[] = [];
  let n = 0;
  const sock: ChatTransport = {
    selfIds: ['972500000000:5@s.whatsapp.net', '4242:5@lid'],
    setTyping: async () => {},
    send: async (jid, text, replyTo) => {
      const id = `BOT${++n}`;
      sent.push({ jid, text, quoted: replyTo?.key.id, id });
      return id;
    },
    sendFile: async (jid, file) => {
      files.push({ jid, file });
      return `BOT${++n}`;
    },
  };
  return { sock, sent, files };
}

export const ME = '972501111111';
export const GROUP = '120363391296187799@g.us';

export const dm = (
  text: string,
  from = `${ME}@s.whatsapp.net`,
  extra: Record<string, unknown> = {},
): RawWhatsAppMessage => ({
  key: { remoteJid: from, id: `IN${Math.random()}`, fromMe: false, ...extra },
  message: { conversation: text },
  pushName: 'Amir',
});

export const groupMsg = (
  message: RawWhatsAppMessage['message'],
  participant = `${ME}@s.whatsapp.net`,
): RawWhatsAppMessage => ({
  key: { remoteJid: GROUP, id: `IN${Math.random()}`, participant },
  message,
  pushName: 'Amir',
});

export const replyTo = (text: string, stanzaId: string, participant: string, quotedText: string) => ({
  extendedTextMessage: { text, contextInfo: { stanzaId, participant, quotedMessage: { conversation: quotedText } } },
});
