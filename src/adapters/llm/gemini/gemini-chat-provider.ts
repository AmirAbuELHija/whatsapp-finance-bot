/**
 * Gemini as a chat AI, with model routing:
 *  1. The request's score (1-10) picks a starting rung on the ladder (lite → flash → flash+thinking → pro).
 *  2. If a model is slow, a faster setting is asked in parallel and the first good answer wins.
 *     If a model times out, is busy or out of quota, another model is tried;
 *     if a model gives a weak answer, the request climbs to a level with more reasoning.
 *  3. Models with problems rest for a while, so later requests skip them.
 */
import { GEMINI } from '../../../config/constants.js';
import { AiProviderError } from '../../../core/errors.js';
import type { ChatProvider, ChatRequest, ChatResponse, Logger } from '../../../core/types.js';
import { classifyFailure, quotaScope, type GeminiApi } from './gemini-api.js';
import { fromGeminiResponse, toGeminiRequest, type GeminiGenerateResponse } from './gemini-mapping.js';
import { ModelHealth, type ModelCatalog, type ModelTier } from './gemini-models.js';

export interface GeminiChatOptions {
  /** Always try this model first; empty = route automatically. */
  model?: string;
  /** "auto" = the ladder decides; "low"/"high"… = always this; "" = never send a thinking setting. */
  thinkingLevel?: string;
  health?: ModelHealth;
  logger?: Logger;
  now?: () => number;
  /** Wait this long for a model before asking a faster one in parallel (tests use a tiny value). */
  hedgeAfterMs?: number;
}

export interface RouteStep {
  model: string;
  tier: ModelTier;
  thinkingLevel: string;
  rung: number;
}

const DEFAULT_SCORE = 5;
const WEAK_FINISH = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT']);
const REFUSAL =
  /^(sorry|i'?m sorry|i (can(?:'|no)?t|cannot|am unable to|don't have)|unfortunately,? i)|לא יכול לעזור|אין לי (?:מספיק )?מידע|لا أستطيع|ليس لدي معلومات/i;
const REFUSAL_MAX_CHARS = 300;
const MIN_ANSWER_CHARS_FOR_HARD_QUESTIONS = 40;
const HARD_SCORE = 7;

/** Starting rung for a 1-10 score. */
export function startRung(score: number): number {
  return GEMINI.scoreBands.find((band) => score <= band.maxScore)?.rung ?? GEMINI.ladder.length - 1;
}

/** A text answer that is empty, cut off, a refusal, or too thin for a hard question. Tool calls are never weak. */
export function isWeakAnswer(response: ChatResponse, score: number): boolean {
  const choice = response.choices[0];
  if (!choice) return true;
  if (choice.message.tool_calls?.length) return false;
  const text = (choice.message.content ?? '').trim();
  if (!text) return true;
  if (choice.finish_reason && WEAK_FINISH.has(choice.finish_reason)) return true;
  if (text.length < REFUSAL_MAX_CHARS && REFUSAL.test(text)) return true;
  return score >= HARD_SCORE && text.length < MIN_ANSWER_CHARS_FOR_HARD_QUESTIONS;
}

type OutcomeBase =
  | { kind: 'ok' | 'weak'; step: RouteStep; response: ChatResponse }
  | { kind: 'timeout' | 'failed' | 'fatal'; step: RouteStep; error: AiProviderError }
  | { kind: 'cancelled'; step: RouteStep };
type Outcome = OutcomeBase & { id: number };

const HEDGE = Symbol('hedge');

/** A timer that resolves to HEDGE, cancellable so finished requests don't keep the process waiting. */
function delay(ms: number, signal: AbortSignal): { promise: Promise<typeof HEDGE>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<typeof HEDGE>((resolve) => {
    timer = setTimeout(() => {
      resolve(HEDGE);
    }, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
    });
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

const isTimeout = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

export class GeminiChatProvider implements ChatProvider {
  readonly name = 'gemini';
  private readonly health: ModelHealth;
  private readonly noThinking = new Set<string>();
  private readonly now: () => number;
  private lastModel: string | null = null;

  constructor(
    private readonly api: GeminiApi,
    private readonly options: GeminiChatOptions = {},
  ) {
    this.health = options.health ?? new ModelHealth();
    this.now = options.now ?? Date.now;
  }

  /** The model that answered last (for logs and the check script). */
  get currentModel(): string | null {
    return this.lastModel;
  }

  /** The rungs to try for a score: the start rung and up, then lighter rungs as a last resort. */
  private rungOrder(score: number) {
    const start = startRung(score);
    const rungs = GEMINI.ladder.map((rung, index) => ({ ...rung, index }));
    return { start, ordered: [...rungs.slice(start), ...rungs.slice(0, start).reverse()] };
  }

  /**
   * The next attempt: the first rung whose tier has a healthy model not yet tried with that thinking level.
   * Resolved live, so a model that just failed is skipped by the following steps.
   */
  private nextStep(
    catalog: ModelCatalog,
    score: number,
    tried: ReadonlySet<string>,
    ignoreRest = false,
    minRung = 0,
    belowRung?: number,
    prefer?: string,
  ): RouteStep | null {
    const { start, ordered: all } = this.rungOrder(score);
    // After a weak answer, only stronger rungs are considered.
    let ordered = minRung > 0 ? all.filter((r) => r.index >= minRung) : all;
    // After a timeout, lighter rungs (less thinking = faster) come first, nearest first.
    if (belowRung !== undefined) {
      const lighter = ordered.filter((r) => r.index < belowRung).sort((a, b) => b.index - a.index);
      ordered = [...lighter, ...ordered.filter((r) => r.index >= belowRung)];
    }
    const fresh = (name: string, thinking: string) =>
      !tried.has(`${name}|${thinking}`) &&
      (ignoreRest || !this.health.isResting(name, thinking)) &&
      this.api.quota.hasRoom(name); // no free quota left: don't even try
    const startThinking = this.thinkingFor(GEMINI.ladder[start]?.thinkingLevel ?? 'low');
    if (minRung === 0 && belowRung === undefined) {
      // 1) the model that just answered this conversation quickly, 2) the pinned GEMINI_MODEL
      for (const name of [prefer, this.options.model]) {
        const model = name ? catalog.all.find((m) => m.name === name) : undefined;
        if (model && fresh(model.name, startThinking))
          return { model: model.name, tier: model.tier, thinkingLevel: startThinking, rung: start };
      }
    }
    for (const rung of ordered) {
      const thinking = this.thinkingFor(rung.thinkingLevel);
      const model = catalog.models(rung.tier).find((m) => fresh(m.name, thinking));
      if (model) return { model: model.name, tier: model.tier, thinkingLevel: thinking, rung: rung.index };
    }
    return null;
  }

  /** The attempts a request with this score would make if every model fails (for the check script and logs). */
  plan(catalog: ModelCatalog, score: number): RouteStep[] {
    const steps: RouteStep[] = [];
    const tried = new Set<string>();
    for (let step = this.nextStep(catalog, score, tried); step; step = this.nextStep(catalog, score, tried)) {
      // Each rung shows only its first choice.
      if (!steps.some((s) => s.rung === step.rung)) steps.push(step);
      for (const m of catalog.models(step.tier)) tried.add(`${m.name}|${step.thinkingLevel}`);
    }
    return steps;
  }

  async create(request: ChatRequest): Promise<ChatResponse> {
    const score = request.score ?? DEFAULT_SCORE;
    const catalog = await this.api.catalog();
    const started = this.now();
    const tried = new Set<string>();
    const stop = new AbortController(); // cancels the slower attempt once one answers
    const running = new Map<number, { step: RouteStep; done: Promise<Outcome>; startedAt: number }>();
    const hedgeAfter = this.options.hedgeAfterMs ?? GEMINI.hedgeAfterMs;
    let hedged = false;
    let answered = false;
    let lastError: AiProviderError | undefined;
    let weakAnswer: ChatResponse | undefined;
    let attempts = 0;
    let nextId = 0;
    let minRung = 0;
    let belowRung: number | undefined;

    const launch = (): boolean => {
      if (attempts >= GEMINI.maxAttemptsPerRequest || this.now() - started > GEMINI.requestBudgetMs) return false;
      // If every model is resting, ignore the rest periods rather than give up.
      const step =
        this.nextStep(catalog, score, tried, false, minRung, belowRung, request.preferModel) ??
        (attempts === 0 ? this.nextStep(catalog, score, tried, true) : null);
      if (!step) return false;
      tried.add(`${step.model}|${step.thinkingLevel}`);
      attempts++;
      const id = nextId++;
      const startedAt = this.now();
      const done = this.attempt(step, request, score, stop.signal).then((outcome): Outcome => ({ ...outcome, id }));
      running.set(id, { step, done, startedAt });
      return true;
    };

    try {
      launch();
      while (running.size) {
        const waiting = [...running.values()].map((r) => r.done);
        const hedge = !hedged && running.size === 1 ? delay(hedgeAfter, stop.signal) : null;
        const first = await Promise.race(hedge ? [...waiting, hedge.promise] : waiting);
        hedge?.cancel();
        if (first === HEDGE) {
          // Slow answer: ask a faster setting in parallel; whichever answers well first wins.
          hedged = true;
          const slow = [...running.values()][0]?.step;
          belowRung = slow?.rung;
          if (launch())
            this.options.logger?.info(
              { waitingFor: slow?.model, afterMs: hedgeAfter },
              'Gemini is slow, asking a faster model in parallel',
            );
          continue;
        }
        const startedAt = running.get(first.id)?.startedAt ?? started;
        running.delete(first.id);
        switch (first.kind) {
          case 'ok':
            answered = true;
            this.lastModel = first.step.model;
            // Answered, but slowly: let faster models go first for the next few minutes.
            if (this.now() - startedAt > hedgeAfter) this.markSlow(first.step);
            this.options.logger?.info(
              {
                model: first.step.model,
                rung: first.step.rung,
                thinking: first.step.thinkingLevel || 'default',
                score,
                ms: this.now() - started,
              },
              'Gemini answered',
            );
            return first.response;
          case 'weak':
            weakAnswer ??= first.response;
            minRung = first.step.rung + 1; // the answer was weak: climb to a model with more reasoning
            belowRung = undefined;
            break;
          case 'timeout':
            lastError = first.error;
            belowRung = first.step.rung; // the next try uses less thinking, which answers faster
            break;
          case 'failed':
            lastError = first.error;
            break;
          case 'fatal':
            throw first.error; // bad key or bad request: the backup AI should take over
          case 'cancelled':
            break;
        }
        if (!running.size) launch();
      }
    } finally {
      // Models still running lost the race to a faster one: let the faster ones go first for a while.
      if (answered) for (const { step } of running.values()) this.markSlow(step);
      stop.abort(); // a slower attempt still running is no longer needed
    }

    if (weakAnswer) return weakAnswer; // better than nothing
    throw lastError ?? new AiProviderError('No Gemini model available', this.name);
  }

  /** Slower than the hedge delay: skipped for a few minutes at this thinking level (not a strike toward 24h). */
  private markSlow(step: RouteStep): void {
    this.health.rest(step.model, 'slow', step.thinkingLevel);
    this.options.logger?.info(
      { model: step.model, thinking: step.thinkingLevel || 'default' },
      'Gemini model is slow right now, faster models go first for 10 minutes',
    );
  }

  /** One model, one try; records the model's health. Never throws, so parallel attempts can't crash the bot. */
  private async attempt(
    step: RouteStep,
    request: ChatRequest,
    score: number,
    cancel: AbortSignal,
  ): Promise<OutcomeBase> {
    let res;
    try {
      res = await this.generate(step, request, cancel);
    } catch (error) {
      if (cancel.aborted) return { kind: 'cancelled', step }; // another model already answered
      if (!isTimeout(error))
        return { kind: 'fatal', step, error: new AiProviderError(`Gemini: ${String(error)}`, this.name) }; // e.g. offline
      const reason = this.health.timedOut(step.model, step.thinkingLevel);
      this.options.logger?.warn(
        {
          model: step.model,
          thinking: step.thinkingLevel || 'default',
          rung: step.rung,
          score,
          removedFor: reason === 'timeout' ? '24h' : '10min',
        },
        'Gemini model timed out, trying a faster setting',
      );
      return {
        kind: 'timeout',
        step,
        error: new AiProviderError(
          `Gemini (${step.model}) did not answer within ${GEMINI.chatTimeoutMs[step.tier] / 1000}s`,
          this.name,
          504,
        ),
      };
    }

    if (res.ok) {
      const response = fromGeminiResponse(res.body, step.model);
      if (!isWeakAnswer(response, score)) return { kind: 'ok', step, response };
      this.options.logger?.warn(
        { model: step.model, rung: step.rung, score },
        'Weak answer, moving up to a stronger model',
      );
      return { kind: 'weak', step, response };
    }

    const message = res.body.error?.message ?? `HTTP ${res.status}`;
    const error = new AiProviderError(`Gemini (${step.model}): ${message}`, this.name, res.status);
    switch (classifyFailure(res.status, res.body)) {
      case 'try-next-model':
        this.health.rest(step.model, 'unavailable');
        break;
      case 'busy':
        this.health.rest(step.model, 'busy');
        break;
      case 'rate-limited': // each model has its own free quota, so another model may still work
        if (quotaScope(res.body) === 'day') this.api.quota.exhaustToday(step.model);
        else this.api.quota.exhaustMinute(step.model);
        break;
      default:
        return { kind: 'fatal', step, error };
    }
    this.options.logger?.warn(
      { model: step.model, status: res.status, rung: step.rung },
      'Gemini model unavailable, moving on',
    );
    return { kind: 'failed', step, error };
  }

  private thinkingFor(rungLevel: string): string {
    const setting = this.options.thinkingLevel ?? 'auto';
    return setting === 'auto' ? rungLevel : setting;
  }

  /** One attempt; retries once without the thinking setting if this model doesn't support it. */
  private async generate(step: RouteStep, request: ChatRequest, signal?: AbortSignal) {
    const timeout = GEMINI.chatTimeoutMs[step.tier];
    const thinkingLevel = this.noThinking.has(step.model) ? '' : step.thinkingLevel;
    const res = await this.api.generate<GeminiGenerateResponse>(
      step.model,
      toGeminiRequest(request, { thinkingLevel }),
      timeout,
      signal,
    );
    if (thinkingLevel && res.status === 400 && /thinking/i.test(res.body.error?.message ?? '')) {
      this.noThinking.add(step.model);
      this.options.logger?.debug({ model: step.model }, 'Model does not take a thinking setting, retrying without it');
      return this.api.generate<GeminiGenerateResponse>(step.model, toGeminiRequest(request), timeout, signal);
    }
    return res;
  }
}
