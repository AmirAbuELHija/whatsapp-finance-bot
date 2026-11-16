/** Entry point: load settings, wire the services, connect to WhatsApp, shut down cleanly. */
import pino from 'pino';
import { createContainer } from './app/container.js';
import { loadEnvFile } from './app/load-env.js';
import { configProblems, loadConfig } from './config/env.js';
import { TIMING } from './config/constants.js';
import { ConfigError } from './core/errors.js';
import { startWhatsApp, type WhatsAppConnection } from './adapters/whatsapp/baileys-connection.js';
import { BaileysTransport } from './adapters/whatsapp/baileys-transport.js';
import { toInboundMessage } from './adapters/whatsapp/message-content.js';

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const logger = pino({ level: config.logLevel });

  const problems = configProblems(config);
  if (problems.length) {
    for (const p of problems) logger.error(p);
    process.exit(1);
  }
  if (config.access.allowEveryone) {
    logger.warn('ALLOW_EVERYONE=true: anyone who can message this account can use the bot and spend your AI quota');
  } else if (!config.access.allowedUsers.length && !config.access.allowedGroups.length) {
    logger.warn(
      'ALLOWED_USERS and ALLOWED_GROUPS are empty: only messages you send from this account will trigger the bot',
    );
  }

  const app = createContainer(config, logger);
  if (!app.video.enabled) logger.info('YouTube summaries are off: add a free GEMINI_API_KEY to .env to turn them on');
  logger.info(
    { envFile, mainAI: app.providers[0]?.name, backup: app.providers[1]?.name ?? 'none', platform: process.platform },
    'Starting WhatsApp finance bot',
  );

  const state: { connection?: WhatsAppConnection } = {};
  const shutdown = (signal: string, code = 0): void => {
    logger.info({ signal }, 'Shutting down');
    state.connection?.close();
    logger.flush();
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }
  process.on('unhandledRejection', (reason) => {
    logger.error({ error: String(reason) }, 'unhandled rejection');
  });

  state.connection = await startWhatsApp({
    authDir: config.whatsapp.authDir,
    pairingNumber: config.whatsapp.pairingNumber,
    trigger: config.bot.trigger,
    logger,
    onMessage: async (sock, raw) => {
      const message = toInboundMessage(raw);
      if (message) await app.handler.handle(new BaileysTransport(sock), message);
    },
    onFatal: (reason) => {
      // Exit code 3 = a person must act (re-link, or stop the other copy): service managers should not
      // restart in a loop (see infra/vm: RestartPreventExitStatus=3).
      shutdown(reason, 3);
    },
  });

  // Heartbeat for monitoring, and a watchdog: if WhatsApp stays disconnected too long, exit so the
  // service manager (systemd / Docker / PM2) starts a fresh process.
  setInterval(() => {
    const connection = state.connection;
    if (!connection) return;
    if (connection.isOpen) {
      logger.info({ heartbeat: true, rssMb: Math.round(process.memoryUsage().rss / 1_048_576) }, 'heartbeat');
      return;
    }
    const downMs = Date.now() - connection.lastOpenAt;
    logger.warn({ downMinutes: Math.round(downMs / 60_000) }, 'WhatsApp is disconnected');
    if (downMs > TIMING.maxDisconnectedMs) shutdown('watchdog: disconnected too long', 1);
  }, TIMING.heartbeatMs).unref();
}

await main();
