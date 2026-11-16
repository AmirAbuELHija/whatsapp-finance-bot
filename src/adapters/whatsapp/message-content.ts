/** Converts Baileys message objects into the platform-neutral InboundMessage. */
import { downloadContentFromMessage, normalizeMessageContent, type proto } from 'baileys';
import { IMAGE_MIME_TYPES } from '../../config/constants.js';
import type { ImageAttachment, InboundMessage, QuotedMessage } from '../../core/types.js';

export type MessageContent = proto.IMessage | null | undefined;

/** The minimal shape of a Baileys WebMessageInfo that we read. */
export interface RawWhatsAppMessage {
  key?: proto.IMessageKey | null;
  message?: MessageContent;
  pushName?: string | null;
}

interface ContextInfoLike {
  stanzaId?: string | null;
  participant?: string | null;
  quotedMessage?: proto.IMessage | null;
  mentionedJid?: string[] | null;
}

function contextInfos(message: MessageContent): ContextInfoLike[] {
  const content = normalizeMessageContent(message);
  if (!content) return [];
  return Object.values(content).flatMap((part: unknown) => {
    if (!part || typeof part !== 'object' || !('contextInfo' in part)) return [];
    const ctx = (part as { contextInfo?: ContextInfoLike | null }).contextInfo;
    return ctx ? [ctx] : [];
  });
}

export function extractText(message: MessageContent): string {
  const m = normalizeMessageContent(message);
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

export function extractMentions(message: MessageContent): string[] {
  for (const ctx of contextInfos(message)) {
    if (ctx.mentionedJid?.length) return ctx.mentionedJid;
  }
  return [];
}

export function extractQuoted(message: MessageContent): QuotedMessage | null {
  for (const ctx of contextInfos(message)) {
    if (ctx.stanzaId || ctx.quotedMessage) {
      return { id: ctx.stanzaId ?? null, sender: ctx.participant ?? null, text: extractText(ctx.quotedMessage) };
    }
  }
  return null;
}

/** The encrypted media fields Baileys needs to download a picture. */
export type ImageMedia = proto.Message.IImageMessage | proto.Message.IDocumentMessage;

/** Downloads one picture; swapped out in tests. */
export type MediaDownloader = (media: ImageMedia, kind: 'image' | 'document') => Promise<Uint8Array>;

export const downloadMedia: MediaDownloader = async (media, kind) => {
  const stream = await downloadContentFromMessage(media, kind);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value); // Long values convert via valueOf()
  return Number.isFinite(n) ? n : null;
};

/** A photo, or a picture sent as a file. */
export function findImage(
  message: MessageContent,
): { media: ImageMedia; kind: 'image' | 'document'; mimeType: string; sizeBytes: number | null } | null {
  const m = normalizeMessageContent(message);
  if (!m) return null;
  if (m.imageMessage) {
    return {
      media: m.imageMessage,
      kind: 'image',
      mimeType: m.imageMessage.mimetype ?? 'image/jpeg',
      sizeBytes: toNumber(m.imageMessage.fileLength),
    };
  }
  const doc = m.documentMessage;
  if (doc?.mimetype && IMAGE_MIME_TYPES.includes(doc.mimetype)) {
    return { media: doc, kind: 'document', mimeType: doc.mimetype, sizeBytes: toNumber(doc.fileLength) };
  }
  return null;
}

/** The picture in the message itself, else the one in the message it replies to. */
export function extractImage(
  message: MessageContent,
  download: MediaDownloader = downloadMedia,
): ImageAttachment | null {
  const own = findImage(message);
  const quoted = own
    ? null
    : contextInfos(message)
        .map((ctx) => findImage(ctx.quotedMessage))
        .find(Boolean);
  const found = own ?? quoted;
  if (!found) return null;
  // WhatsApp sends "image/jpeg; codecs=..." sometimes
  const mimeType = found.mimeType.split(';')[0]?.trim().toLowerCase() || 'image/jpeg';
  return {
    mimeType,
    sizeBytes: found.sizeBytes,
    from: own ? 'message' : 'quoted',
    load: () => download(found.media, found.kind),
  };
}

/** null when the message has no content or no chat (protocol messages, receipts...). */
export function toInboundMessage(
  raw: RawWhatsAppMessage,
  download: MediaDownloader = downloadMedia,
): InboundMessage | null {
  const key = raw.key;
  const chatId = key?.remoteJid;
  if (!key || !chatId || !raw.message) return null;
  return {
    key,
    chatId,
    text: extractText(raw.message),
    mentionedJids: extractMentions(raw.message),
    quoted: extractQuoted(raw.message),
    senderName: raw.pushName ?? null,
    image: extractImage(raw.message, download),
    raw,
  };
}
