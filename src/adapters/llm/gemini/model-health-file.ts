/** Keeps resting Gemini models in a small JSON file, so a restart doesn't retry a model that keeps timing out. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../../../core/types.js';
import type { HealthStore } from './gemini-models.js';
import type { QuotaStore } from './gemini-quota.js';

/** A small JSON file read once at startup and rewritten on every change. */
class JsonFile<T extends object> {
  constructor(
    protected readonly path: string,
    protected readonly logger?: Logger,
  ) {}

  load(): Partial<T> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {}; // no file yet, or unreadable: start fresh
    }
  }

  save(value: T): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(value, null, 2));
    } catch (error) {
      this.logger?.warn({ error: String(error), path: this.path }, 'Could not save Gemini state file');
    }
  }
}

/** Today's request count per model. */
export class JsonFileQuotaStore
  extends JsonFile<{ day: string; counts: Record<string, number> }>
  implements QuotaStore {}

export class JsonFileHealthStore implements HealthStore {
  constructor(
    private readonly path: string,
    private readonly logger?: Logger,
  ) {}

  load(): Record<string, number> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
    } catch {
      return {}; // no file yet, or unreadable: start fresh
    }
  }

  save(entries: Record<string, number>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(entries, null, 2));
    } catch (error) {
      this.logger?.warn({ error: String(error), path: this.path }, 'Could not save Gemini model health');
    }
  }
}
