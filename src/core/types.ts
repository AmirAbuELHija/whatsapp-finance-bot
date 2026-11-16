/** Shapes shared across layers. Adapters translate to and from these. */

export interface Logger {
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
}

// ── Chat completion (OpenAI-style, the agent's internal format) ──────────────

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider-specific data that must travel with the call (e.g. Gemini thought signatures). */
  extra_content?: { google?: { thought_signature?: string | undefined; function_call_id?: string | undefined } };
}

/** A picture sent to the AI. */
export interface ImageInput {
  mimeType: string;
  /** Base64, no data: prefix. */
  data: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImageInput[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolChoice = 'auto' | 'none' | { type: 'function'; function: { name: string } };

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  tool_choice?: ToolChoice;
  temperature?: number;
  max_tokens?: number;
  /** How much reasoning the request needs, 1-10 (see core/ai/request-rating). Providers may use it to pick a model. */
  score?: number;
  /** A model that answered quickly earlier in this conversation turn: try it first again. */
  preferModel?: string;
}

export interface ChatResponse {
  model?: string;
  choices: {
    finish_reason?: string | null;
    message: { content: string | null; tool_calls?: ToolCall[] | undefined };
  }[];
}

/** One chat AI (Gemini, Groq...). The agent tries providers in order. */
export interface ChatProvider {
  readonly name: string;
  create(request: ChatRequest): Promise<ChatResponse>;
}

// ── Market data ──────────────────────────────────────────────────────────────

export interface Quote {
  symbol: string;
  name: string;
  currency: string | null;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  exchange: string | null;
  marketTime: string | null;
  source: string;
}

export interface PriceHistory {
  symbol: string;
  name: string;
  currency: string | null;
  range: string;
  from: string;
  to: string;
  startPrice: number | null;
  endPrice: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  maxDrawdownPct: number | null;
  annualizedVolatilityPct: number | null;
  bars: number;
  source: string;
}

export interface Conversion {
  amount: number;
  from: string;
  to: string;
  rate: number | null;
  result: number | null;
  date?: string | null;
  source?: string;
}

export interface MarketData {
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, range?: string): Promise<PriceHistory>;
  convertCurrency(amount: number, from: string, to: string): Promise<Conversion>;
}

// ── News ─────────────────────────────────────────────────────────────────────

export interface NewsItem {
  title: string;
  source: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface NewsResult {
  topic: string;
  items: NewsItem[];
  source: string;
}

export interface NewsSource {
  getNews(query?: string, options?: { limit?: number }): Promise<NewsResult>;
}

// ── Video ────────────────────────────────────────────────────────────────────

export interface VideoAnswer {
  videoUrl: string;
  title?: string | null;
  channel?: string | null;
  model: string;
  answer: string;
}

export interface VideoAnalyzer {
  readonly enabled: boolean;
  ask(link: string, question?: string): Promise<VideoAnswer>;
}

// ── Chat transport (WhatsApp today; any chat platform could implement it) ────

/** Identifies chat and sender of a message (WhatsApp JIDs, including the newer @lid ids). */
export interface MessageKey {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
  fromMe?: boolean | null;
  id?: string | null;
}

export interface QuotedMessage {
  id: string | null;
  sender: string | null;
  text: string;
}

/** A picture in the message (or in the message it replies to), downloaded only when the bot needs it. */
export interface ImageAttachment {
  mimeType: string;
  /** Size reported by the platform before download, when known. */
  sizeBytes: number | null;
  /** Where the picture is: in this message, or in the message it replies to. */
  from: 'message' | 'quoted';
  load(): Promise<Uint8Array>;
}

/** A file the bot sends back (e.g. a generated document). */
export interface OutgoingFile {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
  caption?: string;
}

export type DocumentFormat = 'docx' | 'pptx';

export interface DocumentSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  table?: { headers: string[]; rows: string[][] };
}

/** What the AI asks for: a Word document or a slide deck, as structured content. */
export interface DocumentSpec {
  format: DocumentFormat;
  title: string;
  subtitle?: string;
  sections: DocumentSection[];
}

export interface DocumentBuilder {
  build(spec: DocumentSpec): Promise<OutgoingFile>;
}

/** A platform-neutral incoming message. */
export interface InboundMessage {
  key: MessageKey;
  chatId: string;
  text: string;
  mentionedJids: string[];
  /** The message this one replies to, if any. */
  quoted: QuotedMessage | null;
  senderName: string | null;
  /** A picture to look at, if any. */
  image: ImageAttachment | null;
  /** The platform's original message object, handed back to the transport when replying. */
  raw: unknown;
}

/** What the bot needs from a chat platform. */
export interface ChatTransport {
  /** The bot's own ids (phone-number JID and LID), used to spot mentions of and replies to the bot. */
  readonly selfIds: readonly string[];
  /** Sends a text, quoting `replyTo` when given. Returns the new message id. */
  send(chatId: string, text: string, replyTo?: InboundMessage): Promise<string | null>;
  /** Sends a file as a document attachment. Returns the new message id. */
  sendFile(chatId: string, file: OutgoingFile, replyTo?: InboundMessage): Promise<string | null>;
  setTyping(chatId: string, typing: boolean): Promise<void>;
}
