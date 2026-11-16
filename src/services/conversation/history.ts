import { LIMITS } from '../../config/constants.js';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** Short per-chat memory so follow-ups ("and in euros?") work. In-memory; cleared on restart or /reset. */
export class ConversationHistory {
  private readonly chats = new Map<string, Turn[]>();

  constructor(
    private readonly maxTurns: number,
    private readonly maxChats: number = LIMITS.historyMaxChats,
  ) {}

  get(chatId: string): readonly Turn[] {
    return this.chats.get(chatId) ?? [];
  }

  add(chatId: string, user: string, assistant: string): void {
    if (this.maxTurns <= 0) return;
    const turns: Turn[] = [
      ...this.get(chatId),
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ];
    this.chats.delete(chatId); // re-insert so the most recent chat is last
    this.chats.set(chatId, turns.slice(-this.maxTurns * 2));
    if (this.chats.size > this.maxChats) {
      const oldest = this.chats.keys().next();
      if (!oldest.done) this.chats.delete(oldest.value);
    }
  }

  clear(chatId: string): void {
    this.chats.delete(chatId);
  }
}
