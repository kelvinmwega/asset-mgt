"use client";

import { useEffect, useState } from "react";

/**
 * The viewer's own IANA timezone, or `undefined` until it is known (AM-10).
 *
 * **`undefined` is a real state, not a placeholder for a missing default.** It
 * is what the server render, the no-JS render and the first client render all
 * see, and callers are expected to fall back to UTC for it — which is why every
 * one of those three shows a correct, UTC-labelled value rather than a blank or
 * a guess at the viewer's zone.
 *
 * Resolved in an effect rather than a `useState` initialiser. An initialiser
 * that probes the environment runs during SSR too, captures whatever the server
 * resolves (UTC on Vercel), and never re-runs — the exact shape LEARNINGS
 * §Frontend records for `useIsMobile`-style hooks. Returning `string |
 * undefined` and reacting to the first real emit is the fix there and here.
 *
 * The second thing this buys is the absence of a hydration mismatch: the first
 * client render is byte-identical to the server's, so the swap to local time is
 * an ordinary post-mount re-render and nothing needs
 * `suppressHydrationWarning`. Suppression would hide real mismatches in the
 * same subtree for good.
 *
 * Nothing is transmitted. The zone is computed in the browser and used there;
 * it never reaches the server, which is what keeps this outside the DPA note's
 * review trigger (DESIGN §5). A timezone cookie would not have that property.
 */
export function useViewerTimeZone(): string | undefined {
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);

  useEffect(() => {
    // `resolvedOptions().timeZone` is an IANA name in every browser this app
    // supports. It can in principle be an empty string on an exotic engine, so
    // an empty value is treated as "not known" and leaves the UTC fallback in
    // place rather than producing a formatter that throws on every row.
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved) {
      setTimeZone(resolved);
    }
  }, []);

  return timeZone;
}
