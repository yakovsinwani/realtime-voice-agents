/**
 * Resolve an API key: an explicitly passed key always wins; otherwise the
 * first non-empty value among the given environment variable names is used.
 */
export function resolveApiKey(
  explicit: string | undefined,
  envNames: readonly string[],
): string | undefined {
  if (explicit) return explicit;
  for (const name of envNames) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}
