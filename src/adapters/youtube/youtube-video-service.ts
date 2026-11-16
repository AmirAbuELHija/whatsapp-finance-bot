/** Answers questions about public YouTube videos with Gemini, which accepts YouTube links directly. */
import { CACHE_TTL_MS, ENDPOINTS, GEMINI, HTTP, LIMITS } from '../../config/constants.js';
import { videoPrompt } from '../../config/prompts.js';
import { TtlCache } from '../../core/cache/ttl-cache.js';
import { UpstreamError, UserInputError } from '../../core/errors.js';
import type { Logger, VideoAnalyzer, VideoAnswer } from '../../core/types.js';
import type { FetchLike } from '../http/http-client.js';
import { classifyFailure, quotaScope, type GeminiApi } from '../llm/gemini/gemini-api.js';
import type { GeminiGenerateResponse } from '../llm/gemini/gemini-mapping.js';
import { extractYouTubeId, watchUrl } from '../../core/text/youtube-link.js';

const SERVICE = 'gemini';
const REFUSAL_MAX_CHARS = 600;
/** Gemini sometimes answers "I can't watch videos" instead of erroring. */
const REFUSAL =
  /(can(?:no|')?t|cannot|unable to|not able to|don't have (?:the ability|access)|do not have (?:the ability|access))\s+(?:to\s+)?(?:watch|view|access|see|open|process|play)|לא (?:יכול|מסוגל|יכולה) לצפות|لا (?:أستطيع|يمكنني) (?:مشاهدة|الوصول)/i;

export const looksLikeRefusal = (text: string): boolean => text.length < REFUSAL_MAX_CHARS && REFUSAL.test(text);

export interface YouTubeVideoOptions {
  /** Preferred Gemini model; empty = auto. */
  model?: string;
  /** Frames per second Gemini looks at; audio is always used. */
  fps?: number;
  /** Fixed answer language, "" = same as the request. */
  language?: string;
  fetchImpl?: FetchLike;
  logger?: Logger;
  now?: () => number;
}

interface VideoPart {
  file_data: { file_uri: string };
  video_metadata?: { fps: number };
}

export class YouTubeVideoService implements VideoAnalyzer {
  private working: string | null;
  private readonly cache: TtlCache<VideoAnswer>;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly api: GeminiApi,
    private readonly options: YouTubeVideoOptions = {},
  ) {
    this.working = options.model || null;
    this.cache = new TtlCache(CACHE_TTL_MS.video, LIMITS.videoCacheEntries, options.now);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get enabled(): boolean {
    return this.api.enabled;
  }

  async ask(link: string, question = ''): Promise<VideoAnswer> {
    if (!this.enabled) throw new UserInputError('YouTube summaries need a free Gemini key: set GEMINI_API_KEY in .env');
    const id = extractYouTubeId(link);
    if (!id) throw new UserInputError('That does not look like a YouTube link');
    const url = watchUrl(id);
    const q = question.trim();
    const cacheKey = `${id}|${q.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const prompt = videoPrompt(q, this.options.language ?? '');
    // Models with free quota left first; the others are still tried last (our count may be off).
    const all = (await this.api.catalog()).videoOrder;
    const candidates = [
      ...all.filter((m) => this.api.quota.hasRoom(m)),
      ...all.filter((m) => !this.api.quota.hasRoom(m)),
    ];
    const order = [...new Set([this.working, ...candidates].filter((m): m is string => Boolean(m)))];
    let lastError: Error | undefined;
    let busy = false;

    for (const model of order) {
      const res = await this.generate(model, url, prompt);
      if (res.ok) {
        const answer = (res.body.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? '')
          .join('')
          .trim();
        if (!answer) {
          const reason = res.body.promptFeedback?.blockReason ?? res.body.candidates?.[0]?.finishReason;
          lastError = new UserInputError(
            `Gemini returned no answer${reason ? ` (${reason})` : ''}. The video may be private, age-restricted or too long`,
          );
          this.options.logger?.warn({ model, reason }, 'Gemini returned an empty answer, trying the next model');
          continue;
        }
        if (looksLikeRefusal(answer)) {
          lastError = new UserInputError(
            "Gemini couldn't open this video (it may be private, age-restricted, region-locked or a live stream)",
          );
          this.options.logger?.warn(
            { model, answer: answer.slice(0, 120) },
            'Gemini said it cannot watch the video, trying the next model',
          );
          if (this.working === model) this.working = null;
          continue;
        }
        if (this.working !== model) this.options.logger?.info({ model }, 'Gemini model selected for YouTube');
        this.working = model;
        const value: VideoAnswer = { videoUrl: url, ...(await this.videoInfo(url)), model, answer };
        this.cache.set(cacheKey, value);
        return value;
      }

      const message = res.body.error?.message ?? `HTTP ${res.status}`;
      lastError = new UpstreamError(message, SERVICE, res.status);
      switch (classifyFailure(res.status, res.body)) {
        case 'try-next-model':
          this.options.logger?.warn(
            { model, status: res.status },
            'Gemini model unavailable on this key, trying the next one',
          );
          if (this.working === model) this.working = null;
          continue;
        case 'busy':
          busy = true;
          this.options.logger?.warn({ model, status: res.status }, 'Gemini model is busy, trying the next one');
          continue;
        case 'auth':
          throw new UpstreamError(
            `Gemini rejected the API key (HTTP ${res.status}: ${message.slice(0, 160)})`,
            SERVICE,
            res.status,
          );
        case 'rate-limited':
          if (quotaScope(res.body) === 'day') {
            this.api.quota.exhaustToday(model);
            this.options.logger?.warn({ model }, 'Gemini daily quota used up for this model, trying the next one');
            continue;
          }
          throw new UpstreamError(
            'The free Gemini limit is used up for now (or the video is too long for it). Try again later or with a shorter video',
            SERVICE,
            429,
          );
        case 'bad-request':
          throw new UpstreamError(`Gemini couldn't process this video: ${message}`, SERVICE, 400);
        case 'other':
          throw lastError;
      }
    }
    if (busy)
      throw new UpstreamError(
        'All free Gemini models are busy right now (Google says "high demand"). Please try again in a few minutes',
        SERVICE,
        503,
      );
    throw lastError ?? new UpstreamError('No Gemini model could process the video', SERVICE);
  }

  private async generate(model: string, url: string, prompt: string) {
    const fps = this.options.fps ?? 0;
    const body = (withFps: boolean) => {
      const video: VideoPart = { file_data: { file_uri: url } };
      if (withFps && fps > 0) video.video_metadata = { fps };
      return { contents: [{ parts: [video, { text: prompt }] }] };
    };
    const res = await this.api.generate<GeminiGenerateResponse>(model, body(true), GEMINI.videoTimeoutMs);
    // Some models/modes don't accept frame-rate settings for YouTube; retry plain.
    if (res.status === 400 && fps > 0)
      return this.api.generate<GeminiGenerateResponse>(model, body(false), GEMINI.videoTimeoutMs);
    return res;
  }

  private async videoInfo(url: string): Promise<{ title?: string | null; channel?: string | null }> {
    try {
      const res = await this.fetchImpl(`${ENDPOINTS.youtubeOembed}?url=${encodeURIComponent(url)}&format=json`, {
        signal: AbortSignal.timeout(HTTP.oembedTimeoutMs),
      });
      if (!res.ok) return {};
      const info = (await res.json()) as { title?: string; author_name?: string };
      return { title: info.title ?? null, channel: info.author_name ?? null };
    } catch {
      return {};
    }
  }
}
