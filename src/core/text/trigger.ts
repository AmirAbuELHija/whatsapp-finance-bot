import { escapeRegExp } from './language.js';

/** The phone-number or LID part of a WhatsApp JID: "9725…:12@s.whatsapp.net" → "9725…". */
export const userPart = (jid: string | null | undefined = ''): string => (jid ?? '').split('@')[0]?.split(':')[0] ?? '';

export interface TriggerOptions {
  trigger?: string;
  mentionedJids?: readonly string[];
  selfIds?: readonly (string | null | undefined)[];
}

/**
 * Returns the request text if the message calls the bot (by trigger word or a real @mention of its number),
 * "" if it was called with nothing else, or null if the message is not for the bot.
 */
export function parseTrigger(text: string | null | undefined, options: TriggerOptions = {}): string | null {
  const { trigger = '@bot', mentionedJids = [], selfIds = [] } = options;
  if (!text) return null;
  let out = text;
  let hit = false;

  const wordRe = new RegExp(`(^|\\s)${escapeRegExp(trigger)}(?:[,:]|(?=$|[\\s.!?]))`, 'gi');
  if (wordRe.test(out)) {
    hit = true;
    out = out.replace(wordRe, '$1');
  }

  const selfUsers = new Set(selfIds.filter((id): id is string => Boolean(id)).map(userPart));
  if (selfUsers.size && mentionedJids.some((jid) => selfUsers.has(userPart(jid)))) {
    hit = true;
    for (const user of selfUsers) out = out.replace(new RegExp(`@${escapeRegExp(user)}\\b[,:]?`, 'g'), '');
  }

  if (!hit) return null;
  return out
    .replace(/[ \t]+/g, ' ')
    .replace(/^[\s,.:!?]+/, '')
    .trim();
}
