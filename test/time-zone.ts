/**
 * Pin the process timezone for a test, and restore it exactly (AM-10).
 *
 * Several AM-10 guards are only meaningful from a non-UTC zone — CI has no `TZ`
 * set and so runs in UTC, where "renders in the viewer's zone" and "renders in
 * UTC" are the same string. Pinning is therefore routine in this suite, and so
 * is getting the restore wrong.
 *
 * **`process.env.TZ = undefined` does not unset the variable.** `process.env`
 * coerces assigned values to strings, so the variable becomes the literal
 * `"undefined"`, which is not a valid zone: from that point
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` returns `undefined` rather
 * than the system zone. Since `TZ` is normally unset on developer machines and
 * in CI alike, the naive save/restore pair
 *
 *     const original = process.env.TZ;   // undefined
 *     process.env.TZ = "Pacific/Midway";
 *     process.env.TZ = original;         // now the STRING "undefined"
 *
 * leaves the process broken rather than restored. `vitest.config.ts` sets
 * `fileParallelism: false`, so every test file after it inherits that state —
 * which is how one careless restore in a timezone test becomes an intermittent
 * failure somewhere else entirely. Restoring means **deleting** when the
 * variable was absent to begin with, which is what this helper exists to get
 * right in one place.
 */
export function pinTimeZone(zone: string): () => void {
  const wasSet = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const original = process.env.TZ;

  process.env.TZ = zone;

  return () => {
    if (wasSet && original !== undefined) {
      process.env.TZ = original;
    } else {
      delete process.env.TZ;
    }
  };
}

/**
 * The same, scoped to one call. Restores even if `body` throws.
 */
export function withTimeZone<T>(zone: string, body: () => T): T {
  const restore = pinTimeZone(zone);
  try {
    return body();
  } finally {
    restore();
  }
}
