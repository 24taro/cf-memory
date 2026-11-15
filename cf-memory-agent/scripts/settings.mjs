// Settings come from the environment first, then <agent home>/config.json, then
// the defaults below. Unknown keys and malformed values fall back to defaults.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS = {
  CF_MEMORY_LOG_ENABLED: { type: 'boolean', default: true },
  CF_MEMORY_RECALL_ENABLED: { type: 'boolean', default: true },
  // The injected text is capped at about 9,600 characters (hook.mjs RECALL_MAX_CHARS),
  // which binds before this token budget for Japanese notes.
  CF_MEMORY_RECALL_BUDGET: { type: 'integer', default: 10000, min: 100, max: 20000 },
};

function parse(spec, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (spec.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return undefined;
  }
  const number = typeof value === 'number' ? value : /^\s*\d+\s*$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number)) return undefined;
  return Math.max(spec.min, Math.min(spec.max, number));
}

export function configPath(home) { return join(home, 'config.json'); }

export function readConfig(home) {
  let raw;
  try { raw = readFileSync(configPath(home), 'utf8'); } catch (error) {
    return error.code === 'ENOENT' ? { values: {} } : { values: {}, error: 'unreadable' };
  }
  if (raw.length > 65536) return { values: {}, error: 'too_large' };
  try {
    const values = JSON.parse(raw);
    if (!values || typeof values !== 'object' || Array.isArray(values)) return { values: {}, error: 'malformed' };
    return { values };
  } catch { return { values: {}, error: 'malformed' }; }
}

export function loadSettings(env = process.env, home) {
  const config = home ? readConfig(home) : { values: {} };
  const result = { source: {} };
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const fromEnv = parse(spec, env[key]), fromConfig = parse(spec, config.values[key]);
    const value = fromEnv ?? fromConfig ?? spec.default;
    result[key] = value;
    result.source[key] = fromEnv !== undefined ? 'env' : fromConfig !== undefined ? 'config' : 'default';
  }
  if (config.error) result.config_error = config.error;
  return {
    log_enabled: result.CF_MEMORY_LOG_ENABLED,
    recall_enabled: result.CF_MEMORY_RECALL_ENABLED,
    recall_budget: result.CF_MEMORY_RECALL_BUDGET,
    source: result.source,
    ...(result.config_error ? { config_error: result.config_error } : {}),
  };
}
