import { HTTP } from '../../config/constants.js';
import { TtlCache } from '../../core/cache/ttl-cache.js';
import { UpstreamError } from '../../core/errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetchImpl?: FetchLike;
  /** Cache successful GET responses for this long (0 = no cache). */
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/** GET helper for public APIs: browser user agent, timeout, optional cache, typed errors. */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly cache: TtlCache<unknown> | null;
  private readonly timeoutMs: number;

  constructor({
    fetchImpl = globalThis.fetch,
    cacheTtlMs = 0,
    timeoutMs = HTTP.timeoutMs,
    now,
  }: HttpClientOptions = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cache = cacheTtlMs > 0 ? new TtlCache(cacheTtlMs, HTTP.maxCacheEntries, now) : null;
  }

  /** `headers` (e.g. an API key) are sent but never part of the cache key or of error messages. */
  getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    return this.get(url, async (res) => (await res.json()) as T, headers);
  }

  getText(url: string): Promise<string> {
    return this.get(url, (res) => res.text());
  }

  private async get<T>(url: string, read: (res: Response) => Promise<T>, extra?: Record<string, string>): Promise<T> {
    const cached = this.cache?.get(url);
    if (cached !== undefined) return cached as T;
    const service = new URL(url).host;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          'User-Agent': HTTP.userAgent,
          Accept: 'application/json, text/xml;q=0.9, */*;q=0.8',
          ...extra,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new UpstreamError(`Could not reach ${service}`, service, undefined, { cause: error });
    }
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status} from ${service}`, service, res.status);
    const value = await read(res);
    this.cache?.set(url, value);
    return value;
  }
}
