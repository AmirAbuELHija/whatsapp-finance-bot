/** Base class for errors the app knows how to handle. `code` is stable and safe to log. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid or missing settings in .env. */
export class ConfigError extends AppError {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message, 'CONFIG_INVALID');
  }
}

/** Bad input from a chat user. The message is written for them and can be shown as-is. */
export class UserInputError extends AppError {
  constructor(message: string) {
    super(message, 'USER_INPUT');
  }
}

/** A third-party HTTP service (Yahoo, Google News, Gemini...) failed. */
export class UpstreamError extends AppError {
  constructor(
    message: string,
    readonly service: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, 'UPSTREAM_FAILED', options);
  }
}

/** Every configured chat AI failed. `status` is the HTTP status of the last failure, when known. */
export class AiProviderError extends AppError {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, 'AI_PROVIDER_FAILED', options);
  }
}

/** HTTP status carried by any error (OpenAI SDK errors, UpstreamError, AiProviderError...). */
export function statusOf(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    return typeof error.status === 'number' ? error.status : undefined;
  }
  return undefined;
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
