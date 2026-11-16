/** LLMs answer in Markdown; WhatsApp uses its own lighter syntax. */
export function toWhatsApp(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*') // **bold** -> *bold*
    .replace(/__(.+?)__/g, '_$1_') // __italic__ -> _italic_
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*') // # Heading -> *Heading*
    .replace(/^(\s*)[*+]\s+/gm, '$1- ') // "* item" -> "- item"
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
