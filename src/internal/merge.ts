/** Recursive plain-object merge; arrays and non-objects replace wholesale. */
export function deepMerge<T extends Record<string, any>>(base: T, patch?: Record<string, any>): T {
  if (!patch) return base;
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
