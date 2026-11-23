/** Decides whether an incoming message is for the bot, and answers it. Platform-neutral (see ChatTransport). */
import { IMAGE_MIME_TYPES, LIMITS, TIMING, WHATSAPP } from '../../config/constants.js';
import type { AppConfig } from '../../config/env.js';
import { DEFAULT_IMAGE_QUESTION, quotedContext } from '../../config/prompts.js';
import { RecentSet } from '../../core/cache/ttl-cache.js';
import { AiProviderError, UserInputError, messageOf, statusOf } from '../../core/errors.js';
import { escapeRegExp, languageFromWord } from '../../core/text/language.js';
import { parseTrigger, userPart } from '../../core/text/trigger.js';
import { extractYouTubeId } from '../../core/text/youtube-link.js';
import { toWhatsApp } from '../../core/text/whatsapp-markdown.js';
import type {
  ChatTransport,
  ImageAttachment,
  ImageInput,
  InboundMessage,
  Logger,
  OutgoingFile,
} from '../../core/types.js';
import { TOOL } from '../agent/tool-registry.js';
import type { CommandRouter } from '../commands/command-router.js';
import { isAuthorized, isGroup, senderIds } from '../security/authorization.js';
import type { RateLimiter } from '../security/rate-limiter.js';

export interface Assistant {
  ask(
    chatId: string,
    text: string,
    options?: {
      senderName?: string | undefined;
      forceTool?: string | undefined;
      images?: ImageInput[] | undefined;
      files?: OutgoingFile[] | undefined;
    },
  ): Promise<string>;
}

export interface MessageHandlerDeps {
  config: Pick<AppConfig, 'bot' | 'access'>;
  logger: Logger;
  commands: CommandRouter;
  agent: Assistant;
  rateLimiter: RateLimiter;
}

const SUMMARY_WORDS = new Set(['summary', 'summery', 'sumary', 'sum', 'סיכום', 'ملخص']);
/** Small words people add that don't change the request ("summary please", "סיכום היום"). */
const FILLER_WORDS = new Set([
  'please',
  'pls',
  'today',
  'now',
  'market',
  'markets',
  'the',
  'daily',
  'בבקשה',
  'היום',
  'שוק',
  'من',
  'فضلك',
  'اليوم',
  'السوق',
]);

/**
 * "@bot summary" (any spelling, any case, with "?" or "!", "please", "today" or a language word) → "/summary [lang]".
 * Anything else, such as "summary of the Fed meeting", is a normal question for the AI.
 */
export function asSummaryCommand(prompt: string): string | null {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const [first, ...rest] = words;
  if (!first || !SUMMARY_WORDS.has(first)) return null;
  const languages = rest.filter((w) => languageFromWord(w));
  if (rest.some((w) => !FILLER_WORDS.has(w) && !languageFromWord(w))) return null;
  return ['/summary', ...languages.slice(0, 1)].join(' ');
}

interface BotRequest {
  prompt: string;
  /** Called with @bot or a real mention (vs. a reply to the bot or a private chat). */
  explicit: boolean;
  quotesBot: boolean;
}

export function friendlyError(error: unknown): string {
  if (error instanceof UserInputError) return error.message;
  const status = statusOf(error);
  if (status === 429)
    return '⏳ The free AI quota is used up for the moment. Try again in a minute, or use a quick command like /price (no AI needed).';
  if (status === 401 || status === 403) return '🔑 The AI provider rejected the API key. Check the keys in .env.';
  if (status === 404) return '🤷 The AI model was not found. Check the model settings in .env.';
  return '⚠️ Something went wrong answering that. Try again, or use a /command.';
}

export class MessageHandler {
  private readonly sentIds = new RecentSet(LIMITS.rememberedSentIds);
  private readonly triggerPattern: RegExp;

  constructor(private readonly deps: MessageHandlerDeps) {
    this.triggerPattern = new RegExp(escapeRegExp(deps.config.bot.trigger), 'gi');
  }

  /** Entry point for every incoming message. Never throws. */
  async handle(transport: ChatTransport, message: InboundMessage): Promise<void> {
    try {
      await this.process(transport, message);
    } catch (error) {
      this.deps.logger.error({ error: messageOf(error) }, 'message handler failed');
    }
  }

  private async process(transport: ChatTransport, msg: InboundMessage): Promise<void> {
    const { config, logger, commands, agent, rateLimiter } = this.deps;
    const { key, chatId } = msg;
    if (chatId === WHATSAPP.statusBroadcastJid || chatId.endsWith(WHATSAPP.newsletterSuffix)) return;
    if (key.id && this.sentIds.has(key.id)) return;

    const request = this.extractRequest(transport, msg);
    if (!request) return;
    const { explicit, quotesBot } = request;
    let { prompt } = request;

    const ids = senderIds(key);
    if (!isAuthorized(config.access, key)) {
      if (explicit)
        logger.info(
          { chatId, senderIds: ids },
          `Ignored ${config.bot.trigger} from a sender not in ALLOWED_USERS / ALLOWED_GROUPS`,
        );
      return;
    }

    const rateKey = key.fromMe ? 'self' : userPart(ids[0] ?? chatId);
    if (!rateLimiter.take(rateKey)) {
      await this.reply(transport, msg, '⏳ Too many requests, give me a minute.', false);
      return;
    }

    const summaryCommand = commands.isCommand(prompt) ? null : asSummaryCommand(prompt);
    if (summaryCommand) prompt = summaryCommand;
    const isCommand = commands.isCommand(prompt);
    const image = isCommand ? null : msg.image;
    logger.info(
      { chatId, sender: rateKey, command: isCommand ? prompt.split(/\s/)[0] : null, image: image?.from ?? null },
      'bot triggered',
    );
    logger.debug({ prompt }, 'prompt');

    const stopTyping = this.showTyping(transport, chatId);
    let answer: string;
    let fromAI = false;
    const files: OutgoingFile[] = []; // documents / slides the AI created
    try {
      if (!prompt && !image) answer = await commands.run('/help', { chatId, senderIds: ids });
      else if (isCommand) answer = await commands.run(prompt, { chatId, senderIds: ids, files });
      else {
        fromAI = true;
        const ask = prompt || DEFAULT_IMAGE_QUESTION;
        const question = msg.quoted?.text ? this.withQuote(ask, msg.quoted.text, quotesBot) : ask;
        const images = image ? [await this.loadImage(image)] : undefined;
        answer = await agent.ask(chatId, question, {
          senderName: isGroup(chatId) ? (msg.senderName ?? undefined) : undefined,
          // a YouTube link always goes to the video tool
          forceTool: !images && extractYouTubeId(question) ? TOOL.video : undefined,
          images,
          files,
        });
      }
    } catch (error) {
      logger.error(
        { error: messageOf(error), status: statusOf(error), ai: error instanceof AiProviderError },
        'failed to answer',
      );
      answer = friendlyError(error);
    } finally {
      await stopTyping();
    }
    await this.reply(transport, msg, answer, fromAI);
    for (const file of files) {
      try {
        const id = await transport.sendFile(msg.chatId, file, msg);
        if (id) this.sentIds.add(id);
        logger.info({ chatId, file: file.fileName, bytes: file.data.byteLength }, 'file sent');
      } catch (error) {
        logger.error({ error: messageOf(error), file: file.fileName }, 'could not send file');
        await this.reply(transport, msg, `⚠️ I made "${file.fileName}" but couldn't send it. Please try again.`, false);
      }
    }
  }

  /** The bot is called by @bot / a real mention, by a reply to one of its messages, or in a private chat (if enabled). */
  private extractRequest(transport: ChatTransport, msg: InboundMessage): BotRequest | null {
    const { config } = this.deps;
    const selfUsers = new Set(transport.selfIds.map(userPart));
    const { quoted } = msg;
    const quotesBot = Boolean(
      quoted && ((quoted.id && this.sentIds.has(quoted.id)) || selfUsers.has(userPart(quoted.sender))),
    );

    let prompt = parseTrigger(msg.text, {
      trigger: config.bot.trigger,
      mentionedJids: msg.mentionedJids,
      selfIds: transport.selfIds,
    });
    const explicit = prompt !== null;
    // A picture without a caption still counts in a private chat or as a reply to the bot.
    const hasContent = Boolean(msg.text.trim()) || msg.image?.from === 'message';
    if (!explicit && !msg.key.fromMe && hasContent) {
      if (quotesBot || (config.access.dmWithoutTrigger && !isGroup(msg.chatId))) prompt = msg.text.trim();
    }
    return prompt === null ? null : { prompt, explicit, quotesBot };
  }

  /** Downloads a picture for the AI, with clear messages for pictures it can't use. */
  private async loadImage(image: ImageAttachment): Promise<ImageInput> {
    const maxMb = LIMITS.maxImageBytes / 1024 / 1024;
    if (!IMAGE_MIME_TYPES.includes(image.mimeType))
      throw new UserInputError('🖼️ I can read JPG, PNG, WEBP and HEIC pictures. Send it as a photo and try again.');
    if (image.sizeBytes !== null && image.sizeBytes > LIMITS.maxImageBytes)
      throw new UserInputError(`🖼️ That picture is too big (max ${maxMb} MB). Send a smaller one or a screenshot.`);
    let bytes: Uint8Array;
    try {
      bytes = await image.load();
    } catch (error) {
      this.deps.logger.warn({ error: messageOf(error) }, 'picture download failed');
      throw new UserInputError("🖼️ I couldn't download that picture (old pictures expire). Send it again and ask me.");
    }
    if (bytes.byteLength > LIMITS.maxImageBytes)
      throw new UserInputError(`🖼️ That picture is too big (max ${maxMb} MB). Send a smaller one or a screenshot.`);
    if (!bytes.byteLength) throw new UserInputError('🖼️ That picture came through empty. Send it again and ask me.');
    return { mimeType: image.mimeType, data: Buffer.from(bytes).toString('base64') };
  }

  /** When someone replies to a message and asks about it ("@bot is this true?"), give the AI that message too. */
  private withQuote(prompt: string, quotedText: string, quotesBot: boolean): string {
    const max = quotesBot ? LIMITS.quotedBotSnippetChars : LIMITS.quotedMessageSnippetChars;
    const snippet = quotedText.length > max ? `${quotedText.slice(0, max)}…` : quotedText;
    return `${quotedContext(quotesBot ? 'bot' : 'member', snippet)}\n${prompt}`;
  }

  /** Shows "typing…" until the returned function is called (chat apps hide it after a while, so it's refreshed). */
  private showTyping(transport: ChatTransport, chatId: string): () => Promise<void> {
    const set = async (typing: boolean) => {
      try {
        await transport.setTyping(chatId, typing);
      } catch {
        // cosmetic only
      }
    };
    void set(true);
    const timer = setInterval(() => void set(true), TIMING.typingRefreshMs);
    return async () => {
      clearInterval(timer);
      await set(false);
    };
  }

  private async reply(transport: ChatTransport, msg: InboundMessage, text: string, fromAI: boolean): Promise<void> {
    const { bot } = this.deps.config;
    // AI text never echoes the trigger word, so the bot can't trigger itself when running on the owner's number.
    const formatted = toWhatsApp(text);
    const body = fromAI ? formatted.replace(this.triggerPattern, bot.trigger.replace(/^@+/, '')) : formatted;
    const id = await transport.send(msg.chatId, `${bot.replyPrefix}${body}`.slice(0, LIMITS.maxReplyChars), msg);
    if (id) this.sentIds.add(id);
  }
}
