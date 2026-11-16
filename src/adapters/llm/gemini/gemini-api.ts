/** Low-level client for Google's native Gemini API, shared by chat and video. */
import { ENDPOINTS, GEMINI } from '../../../config/constants.js';
import type { Logger } from '../../../core/types.js';
import { ModelCatalog } from './gemini-models.js';
import { QuotaTracker } from './gemini-quota.js';
import type { FetchLike } from '../../http/http-client.js';

export interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
}

export interface GeminiErrorBody {
  error?: { code?: number; message?: string; status?: string };
}

export interface GeminiResponse<T> {
  ok: boolean;
  status: number;
  body: T & GeminiErrorBody;
}

/** What to do after a failed generateContent call. */
export type GeminiFailure = 'try-next-model' | 'busy' | 'auth' | 'rate-limited' | 'bad-request' | 'other';

/** "limit: 0" = this model has no free quota at all (a per-minute or per-day 429 just means "used up for now"). */
const QUOTA_ZERO = /limit:\s*0\b|not available/i;
const PER_DAY = /PerDay|per day|daily/i;

/** For a 429: is the daily quota used up (wait for tomorrow) or only this minute's? */
export function quotaScope(body: GeminiErrorBody | null): 'day' | 'minute' {
  return PER_DAY.test(JSON.stringify(body ?? '')) ? 'day' : 'minute';
}
const BUSY = /high demand|overloaded|unavailable/i;
const AUTH = /api key|credential/i;
const NOT_PERMITTED = /permission|not allowed|billing/i;

export function classifyFailure(status: number, body: GeminiErrorBody | null): GeminiFailure {
  const message = body?.error?.message ?? '';
  const raw = JSON.stringify(body ?? '');
  if (status === 404 || (status === 429 && QUOTA_ZERO.test(raw)) || (status === 403 && NOT_PERMITTED.test(message)))
    return 'try-next-model';
  if (status >= 500 || BUSY.test(message)) return 'busy';
  if (status === 401 || (status === 400 && AUTH.test(message))) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status === 400) return 'bad-request';
  return 'other';
}

export class GeminiApi {
  private cachedCatalog: ModelCatalog | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly logger?: Logger,
    /** Model names (or "prefix*") never to use, from GEMINI_EXCLUDE_MODELS. */
    private readonly excludeModels: readonly string[] = [],
    /** GEMINI_MODEL: kept in the catalog even with an unrecognized name. */
    private readonly pinnedModel = '',
    /** Counts requests per model so the router can skip models with no free quota left. */
    readonly quota: QuotaTracker = new QuotaTracker(),
  ) {}

  get enabled(): boolean {
    return Boolean(this.apiKey);
  }

  async request<T>(
    path: string,
    { body, timeoutMs, signal }: { body?: unknown; timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<GeminiResponse<T>> {
    const res = await this.fetchImpl(`${ENDPOINTS.geminiApi}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    });
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      // empty body
    }
    return { ok: res.ok, status: res.status, body: (parsed ?? {}) as T & GeminiErrorBody };
  }

  generate<T>(model: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<GeminiResponse<T>> {
    this.quota.record(model);
    return this.request<T>(`/models/${model}:generateContent`, { body, timeoutMs, signal });
  }

  /** The models this key can use, by tier. Falls back to known names when listing is refused. Cached. */
  async catalog(): Promise<ModelCatalog> {
    if (this.cachedCatalog) return this.cachedCatalog;
    let names: string[] = [];
    try {
      const res = await this.request<{ models?: GeminiModelInfo[] }>(`/models?pageSize=${GEMINI.modelListPageSize}`, {
        timeoutMs: GEMINI.modelListTimeoutMs,
      });
      if (res.ok) {
        names = (res.body.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => (m.name ?? '').replace(/^models\//, ''));
      } else {
        this.logger?.warn(
          { status: res.status, error: res.body.error?.message },
          'Gemini model list unavailable, using known model names',
        );
      }
    } catch (error) {
      this.logger?.warn({ error: String(error) }, 'Gemini model list request failed, using known model names');
    }
    const listed = ModelCatalog.fromNames(names, this.excludeModels, this.pinnedModel);
    this.cachedCatalog = listed.all.length ? listed : ModelCatalog.fromNames(GEMINI.fallbackModels, this.excludeModels);
    this.logger?.info(
      {
        lite: this.cachedCatalog.models('lite').map((m) => m.name),
        flash: this.cachedCatalog.models('flash').map((m) => m.name),
        pro: this.cachedCatalog.models('pro').map((m) => m.name),
        ...(this.excludeModels.length ? { excluded: this.excludeModels } : {}),
      },
      'Gemini models available',
    );
    return this.cachedCatalog;
  }
}
