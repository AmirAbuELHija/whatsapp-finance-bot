import { escapeRegExp } from './language.js';

const INVISIBLE = '\\s\\u200e\\u200f\\u2066-\\u2069*_';

/** Models sometimes imitate the "Name: message" format we give them; drop that from the start of an answer. */
export function stripNamePrefix(answer: string, senderName: string): string {
  const name = escapeRegExp(senderName.trim());
  if (!name) return answer;
  return answer.replace(new RegExp(`^[${INVISIBLE}]*${name}[${INVISIBLE}]*:[*_]*\\s*`, 'u'), '').trim();
}
