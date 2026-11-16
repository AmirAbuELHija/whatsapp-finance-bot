import type { WAMessage, WASocket } from 'baileys';
import type { ChatTransport, InboundMessage, OutgoingFile } from '../../core/types.js';

/** ChatTransport on top of the current Baileys socket. */
export class BaileysTransport implements ChatTransport {
  constructor(private readonly sock: Pick<WASocket, 'user' | 'sendMessage' | 'sendPresenceUpdate'>) {}

  get selfIds(): readonly string[] {
    return [this.sock.user?.id, this.sock.user?.lid].filter((id): id is string => Boolean(id));
  }

  async send(chatId: string, text: string, replyTo?: InboundMessage): Promise<string | null> {
    const quoted = replyTo?.raw as WAMessage | undefined;
    // linkPreview: null = don't fetch previews for links in replies (needs an extra package and slows replies).
    const sent = await this.sock.sendMessage(chatId, { text, linkPreview: null }, quoted ? { quoted } : undefined);
    return sent?.key.id ?? null;
  }

  async sendFile(chatId: string, file: OutgoingFile, replyTo?: InboundMessage): Promise<string | null> {
    const quoted = replyTo?.raw as WAMessage | undefined;
    const caption = file.caption ? { caption: file.caption } : {};
    // Pictures show inline in the chat; everything else arrives as a downloadable document.
    const content = file.mimeType.startsWith('image/')
      ? { image: Buffer.from(file.data), mimetype: file.mimeType, ...caption }
      : { document: Buffer.from(file.data), mimetype: file.mimeType, fileName: file.fileName, ...caption };
    const sent = await this.sock.sendMessage(chatId, content, quoted ? { quoted } : undefined);
    return sent?.key.id ?? null;
  }

  async setTyping(chatId: string, typing: boolean): Promise<void> {
    await this.sock.sendPresenceUpdate(typing ? 'composing' : 'paused', chatId);
  }
}
