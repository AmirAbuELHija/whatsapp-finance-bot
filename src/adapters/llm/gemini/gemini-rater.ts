/** Pre-rating with the fastest Gemini model: one tiny call that returns a 1-10 score. */
import { GEMINI } from '../../../config/constants.js';
import { ratingPrompt } from '../../../config/prompts.js';
import { heuristicScore, parseScore, type RatedRequest, type RequestRater } from '../../../core/ai/request-rating.js';
import type { Logger } from '../../../core/types.js';
import type { GeminiApi } from './gemini-api.js';
import type { GeminiGenerateResponse } from './gemini-mapping.js';
import type { ModelHealth } from './gemini-models.js';

const MAX_OUTPUT_TOKENS = 8;

export class GeminiRater implements RequestRater {
  constructor(
    private readonly api: GeminiApi,
    private readonly health: ModelHealth,
    private readonly logger?: Logger,
  ) {}

  async rate(text: string): Promise<RatedRequest> {
    const fallback: RatedRequest = { score: heuristicScore(text), source: 'heuristic' };
    try {
      const catalog = await this.api.catalog();
      const model = [...catalog.models('lite'), ...catalog.models('flash')].find(
        (m) => !this.health.isResting(m.name, 'low') && this.api.quota.hasRoom(m.name),
      );
      if (!model) return fallback;
      const res = await this.api.generate<GeminiGenerateResponse>(
        model.name,
        {
          contents: [{ role: 'user', parts: [{ text: ratingPrompt(text) }] }],
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0 },
        },
        GEMINI.raterTimeoutMs,
      );
      const reply = (res.body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      const score = res.ok ? parseScore(reply) : null;
      if (score === null) {
        this.logger?.debug({ model: model.name, status: res.status, reply }, 'AI rating unusable, using heuristic');
        return fallback;
      }
      return { score, source: 'ai' };
    } catch (error) {
      this.logger?.debug({ error: String(error) }, 'AI rating failed, using heuristic');
      return fallback;
    }
  }
}
