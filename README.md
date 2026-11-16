# WhatsApp Finance Bot 🤖💸

An AI assistant that lives in WhatsApp. Tag it with **`@bot`** in a group or private chat and it answers like ChatGPT or Gemini, with live tools for markets: quotes, price history, currency conversion, news, finance calculators and YouTube video summaries.

- **Talks naturally** in any language (Arabic, Hebrew, English…). Reply to its message to continue the conversation.
- **Two AIs, automatic failover:** Google Gemini and/or Groq (or any OpenAI-compatible API).
- **Free data sources:** Yahoo Finance, ECB rates, Google News. No paid API keys needed.
- **Runs anywhere Node 22 runs:** macOS, Linux servers, Windows, Docker.

```
You:  @bot how did Nvidia do in the last 6 months, and what's 2,000 USD in shekels?
Bot:  🤖 (calls the price-history and currency tools, then answers with live numbers)

You:  @bot summarize https://youtu.be/...
Bot:  🤖 One-line gist, then the key points, stocks and numbers mentioned in the video.
```

## Contents

- [Quick start](#quick-start)
- [Running it continuously](#running-it-continuously)
- [Using the bot](#using-the-bot)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Development](#development)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

## Quick start

**Requirements:** Node.js 22+ ([nodejs.org](https://nodejs.org), LTS), and a WhatsApp account for the bot (a spare number is recommended).

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
```

Edit `.env`. At minimum:

```ini
MAIN_AI=gemini
GEMINI_API_KEY=...            # free: https://aistudio.google.com/apikey
LLM_API_KEY=...               # optional backup AI, free: https://console.groq.com/keys
ALLOWED_USERS=9725XXXXXXXX    # your own number: country code, no + or leading 0
```

Test the keys, then start:

```bash
npm run check                 # tests both AIs without printing your keys
npm start                     # builds, then starts
```

A QR code appears. On the bot's phone: **WhatsApp → Settings → Linked devices → Link a device**. On a server without a screen, set `PAIRING_NUMBER` to the bot's number and enter the 8-character code instead. The login is saved in `./auth`, so restarts don't need a new scan.

## Running it continuously

The bot must stay online to answer. Pick one:

| Where | How | Notes |
|---|---|---|
| **macOS (your laptop)** | `caffeinate -i npm start` | Stops the Mac from sleeping while it runs. Keep the lid open and plugged in. |
| **Any OS with PM2** | `npm i -g pm2 && npm run build && pm2 start deploy/pm2/ecosystem.config.cjs && pm2 save` | Restarts on crash. Logs: `pm2 logs whatsapp-finance-bot`. Start on boot: `pm2 startup` (Linux/macOS) or the `pm2-installer` package (Windows). |
| **Linux server (systemd)** | Copy the app to `/opt/whatsapp-finance-bot`, then use [`deploy/systemd/whatsapp-finance-bot.service`](deploy/systemd/whatsapp-finance-bot.service) | Hardened service with auto-restart. Logs: `journalctl -u whatsapp-finance-bot -f`. |
| **Docker** | `docker compose -f deploy/docker/docker-compose.yml up -d` | Non-root, read-only container; login kept in the `wa-auth` volume. First run: `docker compose -f deploy/docker/docker-compose.yml logs -f` for the QR / pairing code. |
| **Windows** | `npm start` in a terminal, or PM2 above | Set *Power & sleep → Sleep: Never* while it runs. |
| **Google Cloud (recommended, 24/7)** | [`infra/README.md`](infra/README.md) | Free e2-micro VM, Terraform, keyless GitHub Actions deploys with approval, scans, auto-rollback, alerts. |

While connected, the bot logs a `heartbeat` every 5 minutes, and exits if WhatsApp stays disconnected for
15 minutes so the service manager restarts it. Exit code 3 means a person must act (logged out, or another
copy is running), so services should not restart it in a loop.

## Using the bot

**Ask in your own words:** `@bot what's moving the market today?`, `@bot מה המצב של טבע?`, `@bot explain inflation simply`.

**Continue the conversation:** reply (swipe right) to the bot's message; no `@bot` needed.
**Ask about a message:** reply to anyone's message with `@bot is this true?` or `@bot summarize this`.
**Private chat:** with `DM_WITHOUT_TRIGGER=true` (only when the bot has its own number), every message gets an answer.
**YouTube:** `@bot summarize https://youtu.be/…` (needs `GEMINI_API_KEY`; public videos only).
**Stock report cards:** `@bot report on NVDA` → a picture in the chat with the price, today's move (green/red), a price chart, key stats and news highlights the AI wrote after reading the latest headlines. `@bot NVDA report as slides` sends the same as a deck with a real PowerPoint chart. Numbers and charts always come from market data, never from the AI.
**Documents and slides:** `@bot make 5 slides on this week's Nasdaq` or `@bot write a short report on TEVA` → the bot gathers live data, writes the content and sends a PowerPoint (`.pptx`) or Word (`.docx`) file in the chat. Sections can include live price charts (native charts in slides, pictures in Word). Hebrew and Arabic are laid out right to left. Asked for a PDF, it sends a `.docx` (save it as PDF from Word or Google Docs).
**Market summary slides:** `@bot summary` (also `summery`, `sum`, `סיכום`, `ملخص`, optionally with a language: `@bot summary he`) → two dashboard pictures in a dark trading-terminal style. Slide 1: the day's headline, VIX fear gauge, Nasdaq / S&P 500 / Dow, how many of the 11 sectors fell, the biggest moves in the watchlist, a "why it moved" flow, oil / gold / Bitcoin / 10Y / USD-ILS and what's next. Slide 2: a sector scoreboard, the Nasdaq's 6-month trend, top movers and the six top market news stories. Every number is live from Yahoo Finance at the moment you ask; the AI only writes the words (one call, cached 10 minutes). With a topic (`@bot summary il`) you get the text briefing instead, and if the slides fail you get the text briefing too.
**Pictures:** send a chart, portfolio screenshot, statement or photo with the caption `@bot what do you see?`, or reply to any picture with `@bot is this a breakout?`. In a private chat with `DM_WITHOUT_TRIGGER=true` the picture alone is enough. JPG, PNG, WEBP and HEIC up to 8 MB, also sent as files. Needs `GEMINI_API_KEY`; the Groq backup can't see pictures and says so.

**Optional shortcuts** (instant; only `/summary` uses the AI, cached 10 minutes):

| Command | Example |
|---|---|
| `/price SYMBOL…` | `/price AAPL TEVA.TA BTC USD/ILS` |
| `/history SYMBOL [range]` | `/history NVDA 6mo` (5d 1mo 3mo 6mo ytd 1y 2y 5y 10y max) |
| `/fx [amount] FROM TO` | `/fx 100 USD ILS` |
| `/news [ticker / topic / il]` | `/news`, `/news il`, `/news NVDA`, `/news ריבית בנק ישראל` |
| `/summary [topic] [he/ar/en]` | `/summary` (slides), `/summary il he` (text) |
| `/compound start rate% years [monthly]` | `/compound 10k 7 20 500` |
| `/loan amount rate% years` | `/loan 800k 4.5 25` |
| `/goal target rate% years [saved]` | `/goal 100k 6 10 5000` |
| `/cagr start end years` · `/budget income` | `/cagr 1000 2500 6` · `/budget 12000` |
| `/reset` · `/chatid` · `/help` | forget context · show ids for the allowlist · help |

Symbols use Yahoo format (`TEVA.TA`, `BTC-USD`, `^GSPC`); shortcuts like `BTC`, `SPX`, `TA35`, `GOLD`, `USD/ILS` work too.

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example) for every option with comments). They are validated at startup, and every mistake is listed at once. Real environment variables override the file; `ENV_FILE=/path` loads a different file.

| Setting | Default | Purpose |
|---|---|---|
| `MAIN_AI` | `groq` if `LLM_API_KEY` is set, else `gemini` | Which AI answers first; the other is the automatic backup |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / auto | Gemini key; `GEMINI_MODEL` pins a model to try first (otherwise routed) |
| `GEMINI_EXCLUDE_MODELS` | — | Models never to use (`name` or `prefix*`, comma separated) |
| `GEMINI_FREE_TIER` | `true` | Respect the free per-model limits (skip models with no quota left) |
| `ROUTER_RATING` / `GEMINI_THINKING_LEVEL` | `ai` / `auto` | How questions are rated 1-10; thinking per routing level or forced |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | — / Groq / `openai/gpt-oss-120b` | Any OpenAI-compatible API (Groq, OpenRouter, Ollama) |
| `ALLOWED_USERS` / `ALLOWED_GROUPS` / `ALLOW_EVERYONE` | — / — / `false` | Who may use the bot |
| `DM_WITHOUT_TRIGGER` | `false` | Answer every private message without `@bot` |
| `REPLY_LANGUAGE` | `auto` | `en`, `he`, `ar`… to force one language |
| `BOT_INSTRUCTIONS` | — | Your own rules for the AI; they override the defaults |
| `RATE_LIMIT_PER_MINUTE` / `HISTORY_TURNS` | `6` / `6` | Spam protection / conversation memory |
| `PAIRING_NUMBER` / `AUTH_DIR` | — / `./auth` | Link by code instead of QR / where the login is stored |
| `LOG_LEVEL` / `TIMEZONE` | `info` / `Asia/Jerusalem` | Logging / times in replies |

Technical constants (endpoints, timeouts, cache lifetimes, limits) are in [`src/config/constants.ts`](src/config/constants.ts); ticker aliases, currencies and news feeds in [`src/config/reference-data.ts`](src/config/reference-data.ts); every AI prompt in [`src/config/prompts.ts`](src/config/prompts.ts).

## How Gemini picks a model

Every question goes through a small router before it is answered:

1. **Rating (1-10).** One quick call to the fastest model rates how much reasoning the question needs (`ROUTER_RATING=ai`, the default). If that call is slow or fails, an instant text heuristic is used instead (`ROUTER_RATING=heuristic` uses it always and saves quota).
2. **Routing ladder**, least to most reasoning, built from the models your key actually has, older versions included (newest first, e.g. `gemini-3.8-flash` → `gemini-2.5-flash` → `gemini-2.0-flash-001`; busy `-latest` aliases last; previews and experiments left out). Requests with a picture start at level 1 or higher:

   | Score | Level | Model | Thinking |
   |---|---|---|---|
   | 1-5 | 0 | Flash-Lite | low |
   | 6-7 | 1 | Flash | low |
   | 8-9 | 2 | Flash | high |
   | 10 | 3 | Pro (if available, else the strongest Flash setting) | high |

   On the free tier Flash-Lite allows about 500 requests a day per model and Flash only 20, so most questions go to Flash-Lite.

3. **Escalation by result.** If a model times out, is busy or out of quota, another model at the same level is tried. If the answer is weak (empty, cut off, a refusal, or too thin for a hard question), the request climbs to a level with more reasoning. At most 3 attempts or 60 seconds, then the backup AI takes over.
4. **Slow models are removed.** A model that times out is taken out of rotation for 24 hours at that thinking level (a model too slow with high thinking can still answer light questions). This is saved in `AUTH_DIR/gemini-model-health.json`, so restarts remember it. A busy model rests 10 minutes; one that isn't available on your key, 6 hours.
5. **Gemini 4.** Gemini 4 models use codenames instead of flash/pro. Known ones are routed automatically: Hydrogen (the reported fast Flash model) goes first in the Flash tier as soon as your key lists it, previews included; Argon goes to the Pro tier. A new codename can be used right away with `GEMINI_MODEL=<model id>`, or added to `GEMINI.codenameTiers` in `src/config/constants.ts`.
6. **Free-tier quota.** With `GEMINI_FREE_TIER=true` (default) the bot counts requests per model (saved in `AUTH_DIR/gemini-quota.json`, reset at midnight Pacific like Google's quota) and skips a model with nothing left this minute or today, so no request is wasted on a 429. Models with no free quota (Pro, Argon, Gemini 2.0) are never called. The limits are in `GEMINI.freeTierLimits` in `src/config/constants.ts`; `npm run check` shows today's usage. Set `GEMINI_FREE_TIER=false` on a paid key.
7. **Your own block list.** `GEMINI_EXCLUDE_MODELS` removes models for good.

`npm run check` prints your model list per tier, the models removed for now, which model each score band goes to, and sample ratings.
`npm run check -- --probe` times every model with a tiny question (15 s limit) and prints a ready `GEMINI_EXCLUDE_MODELS=` line for the slow ones.
`npm run check -- --reset-health` puts every removed model back in rotation.

## Architecture

```
src/
├── main.ts                     Entry point: load settings, wire services, connect, graceful shutdown
├── app/                        Composition root (the only place that knows concrete classes)
├── config/                     env.ts (validated settings) · constants.ts · reference-data.ts · prompts.ts
├── core/                       Pure domain code, no I/O
│   ├── ai/                     Request rating (1-10) interface and heuristic
│   ├── finance/                Compound growth, loans, savings goals, CAGR, budgets
│   ├── text/                   Trigger parsing, formatting, WhatsApp markdown, languages
│   ├── cache/                  TTL cache
│   ├── errors.ts               Typed errors: ConfigError, UserInputError, UpstreamError, AiProviderError
│   └── types.ts                Shared interfaces (ChatProvider, MarketData, NewsSource, VideoAnalyzer…)
├── services/                   Application logic, depends only on core interfaces
│   ├── agent/                  ChatAgent (tool-calling loop + provider failover) · tool registry
│   ├── commands/               Slash commands, formatters, help
│   ├── messaging/              MessageHandler: trigger → authorize → rate-limit → answer
│   ├── security/               Allowlist authorization · rate limiter
│   └── conversation/           Per-chat memory
└── adapters/                   Talking to the outside world
    ├── whatsapp/               Baileys connection · ChatTransport implementation · message conversion
    ├── llm/                    OpenAI-compatible provider · Gemini (native API, model catalog, router, rater, mapping)
    ├── market/ news/ youtube/  Yahoo Finance, ECB, Google News, YouTube via Gemini
    └── http/                   Shared HTTP client (timeouts, cache, typed errors)
```

Dependencies point inward: `adapters` and `services` depend on `core`, never the other way, and `services` never import an adapter (only `app/` wires them together). The message handler talks to a `ChatTransport` interface, so adding Telegram or Slack, or swapping Yahoo for another data source, means writing one adapter.

**Adding a tool for the AI:** add a definition in `src/services/agent/tool-registry.ts`.
**Adding a slash command:** add a handler in `src/services/commands/command-router.ts`.

## Development

| Script | What it does |
|---|---|
| `npm run dev` | Run from source with auto-reload |
| `npm run verify` | Everything CI runs: typecheck, lint, format check, tests |
| `npm test` | Unit tests (Node test runner; no network, all external services faked) |
| `npm run lint` / `lint:fix` | ESLint with strict type-aware rules |
| `npm run format` | Prettier |
| `npm run build` | Compile to `dist/` |
| `npm run check -- <youtube link>` | Live health check of keys and Gemini video |

**CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on Linux, Windows and macOS: typecheck, lint, format, tests, build, `npm audit` (blocks on high/critical in production dependencies) and a Docker build. Dependabot keeps npm packages, Actions and the Docker base image up to date.

Stack: TypeScript 6 (strict), Node 22, Baileys 7, OpenAI SDK, Zod, Pino, ESLint + typescript-eslint, Prettier.

## Security notes

- **Secrets:** keep keys in `.env` (git-ignored). For servers use environment variables or your platform's secret store; for CI no secrets are needed (tests use fakes).
- **`auth/` is your WhatsApp login.** Anyone with it controls the bot's account. Never commit or share it.
- **Unofficial WhatsApp API.** Baileys speaks the WhatsApp Web protocol; automating an account can break WhatsApp's terms and accounts can be banned. Use a spare number; the bot only replies when called and never messages first.
- **Allowlist + rate limits** by default. The bot is **read-only**: it can look up data and compute, but has no access to any bank or broker, so prompt injection in a group can't cause real damage.
- **AI data:** questions sent with `@bot` go to your AI provider. On Gemini's free tier Google may use them to improve its products. Don't send sensitive information.
- Not financial advice.

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing happens on `@bot` | Check the logs. "Ignored @bot from a sender not in ALLOWED_USERS" shows the ids to add (groups may use `…@lid` ids; you can also allowlist the group via `/chatid`). |
| "high demand" / AI busy | Automatic: the bot tries other Gemini models, then the backup AI. Run `npm run check` to see which work. |
| Answers are slow / "timed out" in the logs | Run `npm run check -- --probe` and paste the suggested `GEMINI_EXCLUDE_MODELS=` line into `.env`. |
| "I can't see pictures" | Gemini didn't answer, so the Groq backup did. Check `GEMINI_API_KEY` with `npm run check`. |
| "I couldn't download that picture" | WhatsApp media expires after a while; send the picture again. |
| "free AI quota is used up" | Wait a minute, add the other AI as backup, or use `/commands`. |
| `Logged out` | Delete `auth/` and link again. |
| Stops with "Another copy of the bot is connected" (code 440) | Two copies are using the same login. Stop the other one (another terminal, PM2, Docker or server), then start again. |
| Settings error at startup | The message lists every invalid line in `.env`. |
| QR won't scan (server/Docker) | Use `PAIRING_NUMBER`. |
