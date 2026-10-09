export interface LauncherError extends Error {
  code?: string;
  cleanupError?: unknown;
}

export function toError(value: unknown): LauncherError {
  return value instanceof Error ? value : new Error(String(value));
}
