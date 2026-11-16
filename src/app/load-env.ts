import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads settings from a .env file (ENV_FILE, default ./.env) when present.
 * Real environment variables (Docker, systemd, CI) always win over the file.
 */
export function loadEnvFile(path: string = process.env.ENV_FILE ?? '.env'): string | null {
  const file = resolve(path);
  if (!existsSync(file)) return null;
  const before = { ...process.env };
  process.loadEnvFile(file);
  Object.assign(process.env, before);
  return file;
}
