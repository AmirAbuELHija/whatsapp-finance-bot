/** Number and time formatting for chat replies. */

export function round(n: number | null | undefined, digits = 2): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

export function num(n: number | null | undefined, maxDigits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs > 0 && abs < 1 ? Math.max(maxDigits, 4) : maxDigits;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export const money = (n: number | null | undefined, currency?: string | null): string =>
  currency ? `${num(n)} ${currency}` : num(n);

export function signed(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}${num(Math.abs(n), digits)}`;
}

export const pct = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? '—' : `${signed(n)}%`);

export const arrow = (n: number | null | undefined): string => {
  if (n == null || n === 0) return '⚪';
  return n > 0 ? '🟢▲' : '🔴▼';
};

export function shortTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

const MINUTE_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_SHOWN_AS_HOURS = 48;
const HOURS_PER_DAY = 24;

/** "5m ago", "3h ago", "2d ago". */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const minutes = Math.max(0, Math.round((now - t) / MINUTE_MS));
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m ago`;
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_SHOWN_AS_HOURS) return `${hours}h ago`;
  return `${Math.round(hours / HOURS_PER_DAY)}d ago`;
}

const MULTIPLIERS: Readonly<Record<string, number>> = { '': 1, k: 1e3, m: 1e6, b: 1e9 };

/** Accepts 1500, "1,500", "1.5k", "2m", "7%", "₪300". Returns NaN for anything else. */
export function parseAmount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Number.NaN;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[,_\s₪$€£%]/g, '');
  const match = /^(-?\d*\.?\d+)([kmb]?)$/.exec(cleaned);
  if (!match) return Number.NaN;
  const [, digits = '', suffix = ''] = match;
  return Number(digits) * (MULTIPLIERS[suffix] ?? 1);
}
