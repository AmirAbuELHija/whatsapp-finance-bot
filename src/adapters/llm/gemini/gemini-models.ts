/** The Gemini models a key can use, grouped by tier, and which ones are temporarily resting. */
import { GEMINI } from '../../../config/constants.js';

export type ModelTier = 'lite' | 'flash' | 'pro';

export interface CatalogModel {
  name: string;
  tier: ModelTier;
  /** e.g. 3.8; null for "-latest" aliases. */
  version: number | null;
  alias: boolean;
}

/**
 * Stable text models only, old and new: gemini-3.8-flash, gemini-3.5-flash-lite, gemini-3.1-pro,
 * gemini-2.0-flash-001, gemini-flash-latest... Previews, experiments, TTS and image models are left out.
 */
const MODEL_NAME = /^gemini-(?:(\d+(?:\.\d+)?)-)?(flash-lite|flash|pro)(?:-(\d{3})|(-latest))?$/;
/** Gemini 4+ names: gemini-4-flash-preview, gemini-4-hydrogen, gemini-4-argon-preview-11-2026... */
const NEW_GEN_NAME = /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-lite)?)(?:-preview(?:-[\d-]+)?)?$/;

/** Gemini 4 and later: element codenames and previews. */
function classifyNewGeneration(name: string): CatalogModel | null {
  const match = NEW_GEN_NAME.exec(name);
  if (!match) return null;
  const [, version, kind = ''] = match;
  if (Number(version) < GEMINI.previewFromVersion) return null;
  const tier: ModelTier | undefined =
    kind === 'flash-lite' ? 'lite' : kind === 'flash' || kind === 'pro' ? kind : GEMINI.codenameTiers[kind];
  if (!tier) return null; // unknown codename (e.g. a restricted model): only used when pinned with GEMINI_MODEL
  // A preview ranks just below the stable model of the same version.
  const preview = name.includes('-preview') ? 0.0001 : 0;
  return { name, tier, version: Number(version) - preview, alias: false };
}

export function classifyModel(name: string): CatalogModel | null {
  const match = MODEL_NAME.exec(name);
  if (!match) return classifyNewGeneration(name);
  const [, version, kind, revision, latest] = match;
  if (!version && !latest) return null; // bare "gemini-flash" isn't a real model id
  if (revision && !version) return null;
  return {
    name,
    tier: kind === 'flash-lite' ? 'lite' : (kind as ModelTier),
    version: version ? Number(version) + (revision ? Number(revision) / 1e6 : 0) : null,
    alias: Boolean(latest),
  };
}

/** Newest versioned model first; "-latest" aliases last (they point at the busiest model). */
const byPreference = (a: CatalogModel, b: CatalogModel): number => {
  if (a.alias !== b.alias) return a.alias ? 1 : -1;
  return (b.version ?? 0) - (a.version ?? 0);
};

/** Matches an exclusion entry: an exact name, or a prefix ending in "*" (e.g. "gemini-2.0-*"). */
export function isExcluded(name: string, excluded: readonly string[]): boolean {
  return excluded.some((rule) => (rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : name === rule));
}

export class ModelCatalog {
  private readonly byTier: Readonly<Record<ModelTier, readonly CatalogModel[]>>;

  constructor(models: readonly CatalogModel[]) {
    const tier = (t: ModelTier) => models.filter((m) => m.tier === t).sort(byPreference);
    this.byTier = { lite: tier('lite'), flash: tier('flash'), pro: tier('pro') };
  }

  /**
   * @param pinned GEMINI_MODEL: kept even if its name isn't recognized (e.g. a brand-new codename), as Flash tier,
   * provided the key lists it (or the list couldn't be read).
   */
  static fromNames(names: readonly string[], excluded: readonly string[] = [], pinned = ''): ModelCatalog {
    const unique = [...new Set(names)].filter((n) => !isExcluded(n, excluded));
    const models = unique.map(classifyModel).filter((m): m is CatalogModel => m !== null);
    if (pinned && unique.includes(pinned) && !models.some((m) => m.name === pinned))
      models.push({ name: pinned, tier: 'flash', version: null, alias: false });
    return new ModelCatalog(models);
  }

  models(tier: ModelTier): readonly CatalogModel[] {
    return this.byTier[tier];
  }

  get all(): CatalogModel[] {
    return [...this.byTier.lite, ...this.byTier.flash, ...this.byTier.pro];
  }

  /** Video needs a capable model: Flash first, then Pro, then Lite. */
  get videoOrder(): string[] {
    return [...this.byTier.flash, ...this.byTier.pro, ...this.byTier.lite].map((m) => m.name);
  }
}

export type CooldownReason = keyof typeof GEMINI.cooldownMs;

/** Where resting models are kept between restarts (a JSON file in production, nothing in tests). */
export interface HealthStore {
  load(): Record<string, number>;
  save(entries: Record<string, number>): void;
}

/** Key for "this model at this thinking level" (a model may be too slow only when thinking hard). */
export const healthKey = (model: string, thinkingLevel?: string): string =>
  thinkingLevel ? `${model}|${thinkingLevel}` : model;

/**
 * Remembers models that timed out, were busy or are not available on this key, so requests skip them.
 * Entries are either a model name (the whole model rests) or "model|thinking" (only that thinking level).
 */
export class ModelHealth {
  private readonly until = new Map<string, number>();
  /** When each model|thinking last timed out (a single timeout is usually a busy moment, not a slow model). */
  private readonly lastTimeout = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly store?: HealthStore,
  ) {
    if (!store) return;
    const current = this.now();
    for (const [key, time] of Object.entries(store.load())) {
      if (typeof time === 'number' && time > current) this.until.set(key, time);
    }
  }

  rest(model: string, reason: CooldownReason, thinkingLevel?: string): void {
    this.until.set(healthKey(model, thinkingLevel), this.now() + GEMINI.cooldownMs[reason]);
    this.persist();
  }

  /**
   * A timeout: the first one rests the model briefly (busy); a second within a day removes it for a day.
   * Returns which rest was applied.
   */
  timedOut(model: string, thinkingLevel?: string): CooldownReason {
    const key = healthKey(model, thinkingLevel);
    const previous = this.lastTimeout.get(key);
    const repeat = previous !== undefined && this.now() - previous < GEMINI.cooldownMs.timeout;
    this.lastTimeout.set(key, this.now());
    const reason: CooldownReason = repeat ? 'timeout' : 'busy';
    this.rest(model, reason, thinkingLevel);
    return reason;
  }

  /** True if the whole model rests, or (when given) the model at this thinking level. */
  isResting(model: string, thinkingLevel?: string): boolean {
    return this.check(model) || (thinkingLevel ? this.check(healthKey(model, thinkingLevel)) : false);
  }

  /** Everything resting now, with the time it comes back (for the check script). */
  resting(): { key: string; until: Date }[] {
    return [...this.until.keys()]
      .filter((k) => this.check(k))
      .map((key) => ({ key, until: new Date(this.until.get(key) ?? 0) }));
  }

  /** Puts every model back in rotation. */
  clear(): void {
    this.until.clear();
    this.lastTimeout.clear();
    this.persist();
  }

  private check(key: string): boolean {
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  private persist(): void {
    this.store?.save(Object.fromEntries(this.until));
  }
}
