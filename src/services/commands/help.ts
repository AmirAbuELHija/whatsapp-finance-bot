export interface HelpOptions {
  dmWithoutTrigger?: boolean;
  youtube?: boolean;
}

export function helpText({ dmWithoutTrigger = false, youtube = false }: HelpOptions = {}): string {
  const lines = [
    "*Hi! I'm an AI assistant*, like ChatGPT, right here in WhatsApp.",
    '',
    '*Just ask in your own words:*',
    "- @bot what's moving the market today?",
    '- @bot מה המצב של טבע השבוע?',
    '- @bot اشرح لي ما هو صندوق المؤشرات',
    '- @bot if I invest 500 a month at 8% for 15 years, how much will I have?',
    '- @bot write a short birthday message for Dana',
  ];
  lines.push(
    '- 🖼️ Send a chart or screenshot with the caption "@bot what do you see?" (or reply to a picture with @bot)',
  );
  lines.push("- @bot summary _(today's market dashboard slides)_");
  if (youtube) lines.push('- @bot summarize https://youtu.be/... _(or ask: "what does he say about NVDA?")_');
  lines.push(
    '',
    '↩️ To continue the conversation, just *reply* to my message, no @bot needed.',
    '💬 Reply to anyone\'s message with "@bot is this true?" and I\'ll read it.',
  );
  if (dmWithoutTrigger)
    lines.push("🔒 In a private chat with me you don't need @bot at all, just send the question or the picture.");
  lines.push(
    '',
    '_Optional shortcuts:_ /price AAPL · /news il · /summary · /fx 100 USD ILS · /loan 800k 4.5 25 · /reset',
    '',
    '_Not financial advice. Prices may be delayed._',
  );
  return lines.join('\n');
}
