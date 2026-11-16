/** WhatsApp connection via Baileys (WhatsApp Web multi-device protocol). Links like WhatsApp Web: QR or pairing code. */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type GroupMetadata,
  type WASocket,
  type proto,
} from 'baileys';
import type { Logger as PinoLogger } from 'pino';
import qrcode from 'qrcode-terminal';
import { CACHE_TTL_MS, LIMITS, TIMING, WHATSAPP } from '../../config/constants.js';
import { TtlCache } from '../../core/cache/ttl-cache.js';
import { messageOf } from '../../core/errors.js';

export interface WhatsAppOptions {
  authDir: string;
  /** Digits with country code; when set, link with an 8-character code instead of a QR. */
  pairingNumber?: string;
  trigger: string;
  logger: PinoLogger;
  onMessage(sock: WASocket, message: proto.IWebMessageInfo): Promise<void>;
  /** Called when the bot can't keep running (logged out, or another copy took over the login). The process should stop. */
  onFatal(reason: 'logged-out' | 'replaced'): void;
}

export interface WhatsAppConnection {
  /** The current socket (it is replaced on every reconnect). */
  readonly socket: WASocket;
  /** True while connected to WhatsApp. */
  readonly isOpen: boolean;
  /** When the connection was last open (or started), for the self-heal watchdog. */
  readonly lastOpenAt: number;
  close(): void;
}

export async function startWhatsApp(options: WhatsAppOptions): Promise<WhatsAppConnection> {
  const { authDir, logger } = options;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version: [number, number, number] | undefined;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    logger.warn('Could not fetch the latest WhatsApp Web version, using the bundled one');
  }

  // Our own messages, so WhatsApp can ask us to re-send them on decrypt retries.
  const sentStore = new TtlCache<proto.IMessage>(Number.POSITIVE_INFINITY, LIMITS.sentMessageStoreSize);
  const groupCache = new TtlCache<GroupMetadata>(CACHE_TTL_MS.groupMetadata, LIMITS.historyMaxChats);
  let retryDelay: number = TIMING.reconnectInitialMs;
  let closed = false;
  let open = false;
  let lastOpenAt = Date.now();
  let current: WASocket;

  const connect = (): WASocket => {
    const sock: WASocket = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: logger.child({ module: 'baileys' }, { level: 'warn' }),
      browser: Browsers.ubuntu(WHATSAPP.browserName),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: (key) => Promise.resolve(key.id ? sentStore.get(key.id) : undefined),
      cachedGroupMetadata: async (jid) => {
        const hit = groupCache.get(jid);
        if (hit) return hit;
        const meta = await sock.groupMetadata(jid);
        groupCache.set(jid, meta);
        return meta;
      },
    });

    sock.ev.on('creds.update', () => void saveCreds());
    sock.ev.on('groups.update', (updates) => {
      for (const u of updates) if (u.id) groupCache.delete(u.id);
    });
    sock.ev.on('group-participants.update', ({ id }) => {
      groupCache.delete(id);
    });

    let pairingRequested = false;
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) void showLinkCode(sock, qr);
      if (connection === 'open') {
        open = true;
        lastOpenAt = Date.now();
        retryDelay = TIMING.reconnectInitialMs;
        logger.info(
          { id: sock.user?.id, lid: sock.user?.lid },
          `✅ WhatsApp connected. Waiting for "${options.trigger}" messages`,
        );
      }
      if (connection === 'close') {
        if (open) lastOpenAt = Date.now();
        open = false;
      }
      if (connection === 'close' && !closed) {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          logger.error(`Logged out from WhatsApp. Delete the "${authDir}" folder and start again to re-link.`);
          options.onFatal('logged-out');
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          // Reconnecting would just kick the other copy off and start a loop.
          logger.error(
            'Another copy of the bot is connected with the same WhatsApp login (code 440). ' +
              'Stop the other copy (another terminal, PM2, Docker or server), then start this one again.',
          );
          options.onFatal('replaced');
          return;
        }
        logger.warn({ code }, `Connection closed, reconnecting in ${retryDelay / 1000}s`);
        setTimeout(() => {
          if (!closed) current = connect();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, TIMING.reconnectMaxMs);
      }
    });

    const showLinkCode = async (socket: WASocket, qr: string) => {
      if (!options.pairingNumber) {
        console.log('\n📱 Scan with the phone: WhatsApp → Settings → Linked devices → Link a device\n');
        qrcode.generate(qr, { small: true });
        return;
      }
      if (pairingRequested || socket.authState.creds.registered) return;
      pairingRequested = true;
      try {
        const code = await socket.requestPairingCode(options.pairingNumber);
        console.log(
          `\n📱 Pairing code: ${code}\nOn the phone: WhatsApp → Linked devices → Link a device → "Link with phone number instead"\n`,
        );
      } catch (error) {
        logger.error({ error: messageOf(error) }, 'Could not request a pairing code');
      }
    };

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        if (m.key.fromMe && m.key.id && m.message) sentStore.set(m.key.id, m.message);
        // 'notify' = new incoming message (including ones the owner types on the phone); 'append' = sent by this bot.
        if (type !== 'notify') continue;
        options.onMessage(sock, m).catch((error: unknown) => {
          logger.error({ error: messageOf(error) }, 'message handler crashed');
        });
      }
    });

    return sock;
  };

  current = connect();
  return {
    get socket() {
      return current;
    },
    get isOpen() {
      return open;
    },
    get lastOpenAt() {
      return open ? Date.now() : lastOpenAt;
    },
    close() {
      closed = true;
      void current.end(undefined);
    },
  };
}
