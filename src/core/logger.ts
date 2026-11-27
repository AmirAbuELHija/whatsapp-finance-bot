import type { Logger } from './types.js';

const noop = (): void => undefined;

/** A logger that discards everything (tools and tests). */
export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
export const broken: number = 'oops';
