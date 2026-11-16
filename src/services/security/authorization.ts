import { WHATSAPP } from '../../config/constants.js';
import type { AppConfig } from '../../config/env.js';
import { userPart } from '../../core/text/trigger.js';
import type { MessageKey } from '../../core/types.js';

export const isGroup = (jid: string | null | undefined): boolean => (jid ?? '').endsWith(WHATSAPP.groupSuffix);

/** Every id a sender can appear under (phone-number JID and the newer @lid ids). */
export function senderIds(key: MessageKey): string[] {
  const ids = [key.participant, key.participantAlt];
  if (!isGroup(key.remoteJid)) ids.push(key.remoteJid, key.remoteJidAlt);
  return ids.filter((id): id is string => Boolean(id));
}

export function isAuthorized(access: AppConfig['access'], key: MessageKey): boolean {
  if (key.fromMe) return access.respondToSelf;
  if (access.allowEveryone) return true;
  if (key.remoteJid && isGroup(key.remoteJid) && access.allowedGroups.includes(key.remoteJid)) return true;
  const allowed = new Set(access.allowedUsers);
  return senderIds(key).some((id) => allowed.has(userPart(id)));
}
