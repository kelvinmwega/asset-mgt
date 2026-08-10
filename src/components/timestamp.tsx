"use client";

import { exactTimestamp, relativeTime } from "@/lib/relative-time";
import { useViewerTimeZone } from "@/lib/use-viewer-time-zone";

/**
 * One `<time>` element for the whole app, in two variants.
 *
 * `formatTimestamp` had been copy-pasted verbatim into three page files and was
 * byte-identical to `exactTimestamp` in src/lib/relative-time.ts.
 *
 * The variants are not a style choice — they answer different questions:
 *
 * - `exact` — assignment dates and prose. This is an audit register: a
 *   checked-out date is reconciled against, and hover does not exist on touch,
 *   so "3 weeks ago" with no way to reach the real value is a loss.
 * - default — "how stale is this?" cells: last sign-in, the history timeline.
 *   The phrase leads and the exact value stays one hover away, never replaced.
 *
 * `now` is a required parameter of the relative variant rather than a
 * `Date.now()` read, so two rows on a page cannot disagree about "now".
 *
 * **A client component since AM-10**, because the viewer's timezone is knowable
 * only in the browser. Server-rendered pages still import it freely; `value`
 * and `now` are `Date`s, which cross the RSC boundary. What that costs is one
 * post-mount re-render, and what it buys is not sending the viewer's zone to
 * the server (DESIGN §5).
 */
type TimestampProps =
  | { value: Date; exact: true; now?: never }
  | { value: Date; exact?: false; now: Date };

export function Timestamp(props: TimestampProps) {
  const iso = props.value.toISOString();
  const timeZone = useViewerTimeZone();
  // UTC until the browser tells us otherwise: the server render, the no-JS
  // render and the first client render all take this fallback, and all three
  // are correct and say "UTC". Never a guess at the viewer's zone — a wrong
  // time that looks local is worse than a right one that looks foreign.
  const exact = exactTimestamp(props.value, timeZone ?? "UTC");

  // `dateTime` is ALWAYS the UTC ISO value, in both variants and whatever the
  // viewer's zone. This attribute is the machine-readable audit anchor that
  // makes localised display text safe; localising it would remove the one
  // fixed point the rendered string is reconciled against.

  // `whitespace-nowrap` so a timestamp never breaks mid-value. On a phone card
  // the meta line wraps, and without this "2026-05-01 16:00 UTC" splits after
  // "16:00", leaving a bare "UTC" on the next line — verified in a real browser
  // at 390px. The separators around it are ordinary spaces, so the line still
  // breaks BETWEEN values, which is where a break belongs.
  if (props.exact) {
    // No `title`: it would repeat the text the element already shows.
    return (
      <time dateTime={iso} className="whitespace-nowrap">
        {exact}
      </time>
    );
  }

  return (
    <time dateTime={iso} title={exact} className="whitespace-nowrap">
      {relativeTime(props.value, props.now)}
    </time>
  );
}
