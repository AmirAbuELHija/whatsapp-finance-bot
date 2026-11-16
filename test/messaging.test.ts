import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAuthorized, senderIds } from '../src/services/security/authorization.js';
import { CommandRouter, type CommandRouterOptions } from '../src/services/commands/command-router.js';
import { helpText } from '../src/services/commands/help.js';
import { ConversationHistory } from '../src/services/conversation/history.js';
import { MessageHandler, type Assistant } from '../src/services/messaging/message-handler.js';
import { toInboundMessage, type RawWhatsAppMessage } from '../src/adapters/whatsapp/message-content.js';
import type { ChatTransport } from '../src/core/types.js';
import { RateLimiter } from '../src/services/security/rate-limiter.js';
import { AiProviderError } from '../src/core/errors.js';
import type { NewsSource } from '../src/core/types.js';
import { TOOL } from '../src/services/agent/tool-registry.js';
import { GROUP, ME, dm, fakeMarket, fakeSocket, groupMsg, makeConfig, replyTo, silentLogger } from './helpers.js';

const news: NewsSource = {
  getNews: async (q = '') => ({
    topic: q === 'il' ? 'בורסת תל אביב' : q || 'Markets',
    source: 'Google News',
    items: [{ title: `Story about ${q || 'markets'}`, source: 'Reuters', url: 'https://x.y/1', publishedAt: null }],
  }),
};

/** Pretend WhatsApp download: the picture's url says what comes back. */
const fakeDownload = async (media: { url?: string | null }) => {
  if (media.url === 'expired') throw new Error('410 Gone');
  return new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
};

function setup(
  env: Record<string, string> = {},
  agentImpl?: Assistant['ask'],
  extra: Partial<CommandRouterOptions> = {},
) {
  const config = makeConfig({ ALLOWED_USERS: '+972-50-111-1111', RATE_LIMIT_PER_MINUTE: '3', ...env });
  const asked: { chatId: string; text: string; options: any }[] = [];
  const agent: Assistant = {
    ask:
      agentImpl ??
      (async (chatId, text, options) => {
        asked.push({ chatId, text, options });
        return 'Answer about **@bot** stuff';
      }),
  };
  const history = new ConversationHistory(6);
  const summarizer = {
    summarize: async ({ topic, language }: { topic: string; language: string }) => `Summary of ${topic} in ${language}`,
  };
  const commands = new CommandRouter({
    market: fakeMarket,
    news,
    history,
    summarizer,
    timezone: 'Asia/Jerusalem',
    dmWithoutTrigger: config.access.dmWithoutTrigger,
    ...extra,
  });
  const real = new MessageHandler({
    config,
    logger: silentLogger,
    commands,
    agent,
    rateLimiter: new RateLimiter(config.access.rateLimitPerMinute),
  });
  // Tests feed raw WhatsApp-shaped messages through the same conversion the app uses.
  const handler = {
    handle: async (transport: ChatTransport, raw: RawWhatsAppMessage) => {
      const message = toInboundMessage(raw, fakeDownload);
      if (message) await real.handle(transport, message);
    },
  };
  return { handler, asked, ...fakeSocket(), commands };
}

// ── Authorization ────────────────────────────────────────────────────────────

test('authorization: own messages, allowlisted users (PN or LID alt), allowlisted groups, strangers', () => {
  const access = makeConfig({ ALLOWED_USERS: ME, ALLOWED_GROUPS: '123-456@g.us' }).access;
  assert.equal(isAuthorized(access, { fromMe: true, remoteJid: 'x@s.whatsapp.net' }), true);
  assert.equal(isAuthorized(access, { remoteJid: `${ME}@s.whatsapp.net` }), true);
  assert.equal(isAuthorized(access, { remoteJid: '999@lid', remoteJidAlt: `${ME}@s.whatsapp.net` }), true);
  assert.equal(
    isAuthorized(access, { remoteJid: '777@g.us', participant: '555@lid', participantAlt: `${ME}@s.whatsapp.net` }),
    true,
  );
  assert.equal(isAuthorized(access, { remoteJid: '123-456@g.us', participant: '000@lid' }), true);
  const stranger = { remoteJid: '777@g.us', participant: '555@lid', participantAlt: '972509999999@s.whatsapp.net' };
  assert.equal(isAuthorized(access, stranger), false);
  assert.equal(isAuthorized({ ...access, allowEveryone: true }, stranger), true);
  assert.deepEqual(senderIds({ remoteJid: '1@g.us', participant: '2@lid' }), ['2@lid']);
});

// ── Message handling ─────────────────────────────────────────────────────────

test('@bot question → AI reply, quoted, WhatsApp-formatted, trigger never echoed', async () => {
  const { handler, asked, sock, sent } = setup();
  const msg = dm('@bot how is AAPL doing?');
  await handler.handle(sock, msg);
  assert.equal(asked[0]!.text, 'how is AAPL doing?');
  assert.equal(sent[0]!.quoted, msg.key?.id);
  assert.equal(sent[0]!.text, '🤖 Answer about *bot* stuff');
});

test('slash commands run without the AI; help keeps "@bot" in its examples', async () => {
  const { handler, asked, sock, sent } = setup();
  await handler.handle(sock, dm('@bot /fx 100 usd to ils'));
  await handler.handle(sock, dm('@bot /loan 200k 6 30'));
  await handler.handle(sock, dm('@bot'));
  assert.equal(asked.length, 0);
  assert.match(sent[0]!.text, /100 USD = 370 ILS/);
  assert.match(sent[1]!.text, /1,199\.1/);
  assert.match(sent[2]!.text, /Just ask in your own words/);
  assert.match(sent[2]!.text, /@bot what's moving the market/);
});

test("ignored: no trigger, strangers, and the bot's own replies", async () => {
  const { handler, asked, sock, sent } = setup();
  await handler.handle(sock, dm('what is AAPL'));
  await handler.handle(sock, dm('@bot hi', '972509999999@s.whatsapp.net'));
  await handler.handle(
    sock,
    dm('@bot hi', '1-2@g.us', { participant: '77@lid', participantAlt: '972509999999@s.whatsapp.net' }),
  );
  assert.equal(sent.length + asked.length, 0);
  await handler.handle(sock, dm('@bot /price X'));
  await handler.handle(sock, {
    key: { remoteJid: `${ME}@s.whatsapp.net`, id: sent[0]!.id, fromMe: true },
    message: { conversation: sent[0]!.text },
  });
  assert.equal(sent.length, 1);
});

test('owner on their own number can trigger it; group members via LID alt id get named', async () => {
  const own = setup({ ALLOWED_USERS: '' });
  await own.handler.handle(own.sock, dm('@bot compare TSLA and BYD', 'friend@s.whatsapp.net', { fromMe: true }));
  assert.equal(own.asked.length, 1);

  const grp = setup();
  await grp.handler.handle(
    grp.sock,
    dm('@bot hello', '120363@g.us', { participant: '5555@lid', participantAlt: `${ME}@s.whatsapp.net` }),
  );
  assert.equal(grp.asked[0]!.options.senderName, 'Amir');
});

test('a real @mention of the bot works (LID)', async () => {
  const { handler, asked, sock, sent } = setup();
  await handler.handle(sock, {
    key: { remoteJid: '120363@g.us', id: 'M1', participant: `${ME}@s.whatsapp.net` },
    message: { extendedTextMessage: { text: '@4242 /price AAPL', contextInfo: { mentionedJid: ['4242@lid'] } } },
  });
  assert.match(sent[0]!.text, /AAPL/);
  assert.equal(asked.length, 0);
});

test('rate limit per sender; AI quota errors become a friendly message', async () => {
  const limited = setup();
  for (let i = 0; i < 4; i++) await limited.handler.handle(limited.sock, dm('@bot /help'));
  assert.match(limited.sent.at(-1)!.text, /Too many requests/);

  const failing = setup({}, async () => {
    throw new AiProviderError('quota', 'groq', 429);
  });
  await failing.handler.handle(failing.sock, dm('@bot anything'));
  assert.match(failing.sent[0]!.text, /free AI quota/);
});

// ── Conversation like ChatGPT ────────────────────────────────────────────────

test('replying to the bot continues without @bot (by message id or LID); other replies ignored', async () => {
  const { handler, asked, sock } = setup({ ALLOWED_GROUPS: GROUP });
  await handler.handle(sock, groupMsg({ conversation: '@bot what is an ETF?' }));
  await handler.handle(
    sock,
    groupMsg(replyTo('and vs a mutual fund?', 'BOT1', '972500000000@s.whatsapp.net', '🤖 answer 1')),
  );
  await handler.handle(sock, groupMsg(replyTo('thanks, and Tesla?', 'OLD-ID', '4242@lid', 'old answer')));
  await handler.handle(
    sock,
    groupMsg(replyTo('yes I bought', 'X1', '972509999999@s.whatsapp.net', 'anyone buying NVDA?')),
  );
  await handler.handle(sock, groupMsg({ conversation: 'anyone buying NVDA today?' }));
  assert.equal(asked.length, 3);
  assert.equal(asked[1]!.text, '[Replying to your earlier answer: "🤖 answer 1"]\nand vs a mutual fund?');
});

test('"@bot is this true?" on someone else\'s message passes that message along', async () => {
  const { handler, asked, sock } = setup({ ALLOWED_GROUPS: GROUP });
  await handler.handle(
    sock,
    groupMsg(
      replyTo('@bot is this true?', 'X2', '972509999999@s.whatsapp.net', 'Nvidia is replacing its CEO next week'),
    ),
  );
  assert.equal(
    asked[0]!.text,
    '[Replying to a message from another member: "Nvidia is replacing its CEO next week"]\nis this true?',
  );
});

test('private chat without @bot only when DM_WITHOUT_TRIGGER=true, only for allowed users, never for own outgoing', async () => {
  const on = setup({ DM_WITHOUT_TRIGGER: 'true' });
  await on.handler.handle(on.sock, dm('what is the S&P 500?'));
  await on.handler.handle(on.sock, dm('hi bot', '972509999999@s.whatsapp.net'));
  await on.handler.handle(on.sock, dm('hello', `${ME}@s.whatsapp.net`, { fromMe: true }));
  assert.deepEqual(
    on.asked.map((a) => a.text),
    ['what is the S&P 500?'],
  );
  const off = setup();
  await off.handler.handle(off.sock, dm('what is the S&P 500?'));
  assert.equal(off.asked.length, 0);
});

test('a YouTube link forces the video tool', async () => {
  const { handler, asked, sock } = setup();
  await handler.handle(sock, dm('@bot اعطينا الفوائد https://youtu.be/T3LdlJH2iLE?si=g7AwmuJUrzAMcZ9g'));
  await handler.handle(sock, dm('@bot what is an ETF?'));
  assert.equal(asked[0]!.options.forceTool, TOOL.video);
  assert.equal(asked[1]!.options.forceTool, undefined);
});

// ── Pictures ─────────────────────────────────────────────────────────────────

const photo = (caption = '', extra: Record<string, unknown> = {}) => ({
  imageMessage: { caption, mimetype: 'image/jpeg', fileLength: 1234, url: 'ok', ...extra },
});
const imageDm = (message: RawWhatsAppMessage['message'], from = `${ME}@s.whatsapp.net`): RawWhatsAppMessage => ({
  key: { remoteJid: from, id: `IN${Math.random()}`, fromMe: false },
  message,
  pushName: 'Amir',
});

test('a picture with "@bot ..." as caption goes to the AI with the picture', async () => {
  const { handler, asked, sent, sock } = setup({ ALLOWED_GROUPS: GROUP });
  await handler.handle(sock, groupMsg(photo('@bot what does this chart show?')));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.text, 'what does this chart show?');
  assert.deepEqual(asked[0]!.options.images, [
    { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0x01]).toString('base64') },
  ]);
  assert.equal(sent.length, 1);
  // A picture without @bot in a group is ignored.
  await handler.handle(sock, groupMsg(photo('nice chart')));
  assert.equal(asked.length, 1);
});

test('replying "@bot" to someone\'s picture analyzes that picture; a bare "@bot" gets the default question', async () => {
  const { handler, asked, sock } = setup({ ALLOWED_GROUPS: GROUP });
  const quotingPhoto = (text: string) => ({
    extendedTextMessage: {
      text,
      contextInfo: {
        stanzaId: 'P1',
        participant: '972509999999@s.whatsapp.net',
        quotedMessage: photo('TEVA breakout?', { mimetype: 'image/png; codecs=x' }),
      },
    },
  });
  await handler.handle(sock, groupMsg(quotingPhoto('@bot is this a real breakout?')));
  await handler.handle(sock, groupMsg(quotingPhoto('@bot')));
  assert.equal(asked[0]!.options.images[0].mimeType, 'image/png');
  assert.match(asked[0]!.text, /TEVA breakout\?[\s\S]*is this a real breakout\?$/);
  assert.match(asked[1]!.text, /Look at this picture/);
  assert.equal(asked[1]!.options.images.length, 1);
});

test('private chat: a picture alone is enough with DM_WITHOUT_TRIGGER; picture files work too', async () => {
  const { handler, asked, sock } = setup({ DM_WITHOUT_TRIGGER: 'true' });
  await handler.handle(sock, imageDm(photo()));
  await handler.handle(
    sock,
    imageDm({ documentMessage: { mimetype: 'image/webp', fileLength: 10, url: 'ok', caption: 'my portfolio' } }),
  );
  await handler.handle(
    sock,
    imageDm({ documentMessage: { mimetype: 'application/pdf', url: 'ok', caption: 'report' } }),
  );
  assert.equal(asked.length, 3);
  assert.match(asked[0]!.text, /Look at this picture/);
  assert.equal(asked[1]!.options.images[0].mimeType, 'image/webp');
  assert.equal(asked[2]!.options.images, undefined); // a PDF is not a picture
});

test('pictures that are too big, unsupported or expired get a clear message and no AI call', async () => {
  const { handler, asked, sent, sock } = setup({ ALLOWED_GROUPS: GROUP });
  await handler.handle(sock, groupMsg(photo('@bot look', { fileLength: 50 * 1024 * 1024 })));
  await handler.handle(sock, groupMsg(photo('@bot look', { mimetype: 'image/gif' })));
  await handler.handle(sock, groupMsg(photo('@bot look', { url: 'expired' })));
  assert.equal(asked.length, 0);
  assert.match(sent[0]!.text, /too big \(max 8 MB\)/);
  assert.match(sent[1]!.text, /JPG, PNG, WEBP and HEIC/);
  assert.match(sent[2]!.text, /couldn't download that picture/);
});

// ── Files ────────────────────────────────────────────────────────────────────

test('files the AI creates are sent after the text answer, quoting the question', async () => {
  const { handler, sent, files, sock } = setup({ ALLOWED_GROUPS: GROUP }, async (_chat, _text, options) => {
    options?.files?.push({ fileName: 'deck.pptx', mimeType: 'application/x', data: new Uint8Array([1]) });
    return 'Here are your slides';
  });
  await handler.handle(sock, groupMsg({ conversation: '@bot make slides about NVDA' }));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /Here are your slides/);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.file.fileName, 'deck.pptx');
  assert.equal(files[0]!.jid, GROUP);
});

test('"@bot summery" (no slash) sends the dashboard slides after the text, not the AI', async () => {
  const { handler, asked, sent, files, sock } = setup({ ALLOWED_GROUPS: GROUP }, undefined, {
    dashboard: {
      build: async () => ({
        text: 'Market wrap',
        files: [1, 2].map((n) => ({ fileName: `s${n}.png`, mimeType: 'image/png', data: new Uint8Array([n]) })),
      }),
    },
  });
  await handler.handle(sock, groupMsg({ conversation: '@bot summery' }));
  await handler.handle(sock, groupMsg({ conversation: '@bot summary of the fed meeting please' }));
  assert.match(sent[0]!.text, /Market wrap/);
  assert.deepEqual(
    files.map((f) => f.file.fileName),
    ['s1.png', 's2.png'],
  );
  assert.equal(asked.length, 1); // a longer sentence is a normal AI question
});

// ── Commands ─────────────────────────────────────────────────────────────────

test('/news and /summary (languages, presets, caching)', async () => {
  let now = 0;
  const calls: string[] = [];
  const commands = new CommandRouter({
    market: fakeMarket,
    news,
    history: new ConversationHistory(6),
    summarizer: {
      summarize: async ({ topic, language }) => (
        calls.push(`${topic}|${language}`),
        `Summary of ${topic} in ${language}`
      ),
    },
    timezone: 'UTC',
    summaryLanguage: 'en',
    now: () => now,
  });
  const ctx = { chatId: 'c' };
  assert.match(await commands.run('/news', ctx), /📰 \*Markets\*/);
  assert.match(await commands.run('/news ריבית בנק ישראל', ctx), /Story about ריבית בנק ישראל/);
  assert.equal(await commands.run('/summary', ctx), 'Summary of Global markets in English');
  assert.equal(await commands.run('/summary il he', ctx), 'Summary of בורסת תל אביב in Hebrew');
  assert.equal(await commands.run('/brief بالعربي', ctx), 'Summary of Global markets in Arabic');
  await commands.run('/summary', ctx); // cached
  assert.equal(calls.length, 3);
  now = 11 * 60_000;
  await commands.run('/summary', ctx);
  assert.equal(calls.length, 4);
});

test('commands: usage messages, unknown commands, help options', async () => {
  const { commands } = setup();
  const ctx = { chatId: 'c' };
  assert.equal(await commands.run('/goal 5', ctx), '⚠️ Usage: /goal target rate% years [saved]');
  assert.match(await commands.run('/nope', ctx), /Unknown command \/nope/);
  assert.doesNotMatch(helpText({ youtube: false }), /youtu\.be/);
  assert.match(helpText({ youtube: true, dmWithoutTrigger: true }), /summarize https:\/\/youtu\.be[\s\S]*private chat/);
});

test('WhatsApp transport: replies quote the message and never build link previews', async () => {
  const { BaileysTransport } = await import('../src/adapters/whatsapp/baileys-transport.js');
  const calls: any[] = [];
  const sock = {
    user: { id: '9725:1@s.whatsapp.net', lid: '42:1@lid' },
    sendMessage: async (jid: string, content: unknown, options: unknown) => (
      calls.push({ jid, content, options }),
      { key: { id: 'S1' } }
    ),
    sendPresenceUpdate: async () => {},
  };
  const transport = new BaileysTransport(sock);
  const raw = dm('@bot hi');
  const inbound = toInboundMessage(raw)!;
  assert.equal(await transport.send(inbound.chatId, 'see https://youtu.be/x', inbound), 'S1');
  assert.deepEqual(calls[0].content, { text: 'see https://youtu.be/x', linkPreview: null });
  assert.equal(calls[0].options.quoted, raw);
  assert.deepEqual(transport.selfIds, ['9725:1@s.whatsapp.net', '42:1@lid']);
});
