import type { ModrinthVersion } from './types.js';

export interface McpmError extends Error {
  code?: string;
  cleanupError?: unknown;
  rollbackError?: unknown;
  recoveryDirectory?: string;
  projectId?: string;
  requiredVersion?: ModrinthVersion;
}

export function toError(value: unknown): McpmError {
  return value instanceof Error ? value : new Error(String(value));
}
