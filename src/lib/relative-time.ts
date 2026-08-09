/**
 * Human-scale time for the asset history (AM-09 DESIGN §4.3).
 *
 * The history rendered `2026-08-01 21:21 UTC` on every row. That is what an
 * auditor needs and it is not what a human checks — "was this assigned
 * recently, or has it been out for a year?" is answered by a phrase, and the
 * timestamp is the detail you go to afterwards. So the phrase leads and the
 * exact value stays one hover away, never replaced.
 *
 * Deliberately coarse. This is not a countdown: an event that happened 40
 * minutes ago and one that happened 50 both read "under an hour ago", because
 * the difference does not change any decision and false precision invites
 * someone to trust it for reconciliation, which is what the timestamp is for.
 *
 * Pure and dependency-free, so it is a unit test rather than a render test, and
 * so the same function can label a timeline on either side of the boundary.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `now` is a parameter, not `Date.now()` — a function that reads the clock
 * cannot be tested without freezing time, and this one is called several times
 * per render, where two rows disagreeing about "now" would be a real bug.
 */
export function relativeTime(value: Date, now: Date): string {
  const elapsed = now.getTime() - value.getTime();

  // A clock skew or a record dated slightly ahead of the server: say something
  // true rather than "in -3 days".
  if (elapsed < 0) return "just now";
  if (elapsed < HOUR) return "under an hour ago";

  const hours = Math.floor(elapsed / HOUR);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;

  const days = Math.floor(elapsed / DAY);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;

  // Each unit is derived from the one below it, never from `elapsed` again.
  // Deriving months from a 30-day month and years from a 365-day year let the
  // two disagree: at 360 days `days / 30` is already 12 while `days / 365` is
  // still 0, so five days a year rendered "0 years ago". One cascade, one
  // boundary, nothing to keep in step.
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;

  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/**
 * `Intl.DateTimeFormat` construction is the expensive part, and this is called
 * once per row on a page that renders every asset. One formatter per zone, and
 * in practice the map holds one entry: the viewer's.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      // `hourCycle` rather than `hour12: false`, which is the form that renders
      // midnight as "24:00" under some locale/engine pairs. Both are correct in
      // en-GB today; only one says so.
      hourCycle: "h23",
      // The zone is NEVER omitted — see the docblock on exactTimestamp.
      timeZoneName: "short",
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The exact value, for the `title` and for anything reconciling against another
 * system.
 *
 * AM-09 rendered this in UTC for every viewer, reasoning that an audit trail
 * which renders differently per viewer is not one. AM-10 reverses that: staff
 * are in UTC+3, so every reader was doing the arithmetic by hand. **The audit
 * property is kept by two things instead, and neither is optional.**
 *
 * 1. **The zone is always in the visible text** — `2026-08-01 21:21 GMT+3`,
 *    never a bare `21:21`. A screenshot that does not name its own clock cannot
 *    be reconciled against another system, and two admins comparing screens
 *    could not tell a timezone difference from a data difference.
 * 2. **`<time dateTime>` stays UTC ISO-8601** (see src/components/timestamp.tsx).
 *    That attribute, not this string, is the machine-readable anchor.
 *
 * `timeZone` is a required parameter rather than an ambient
 * `resolvedOptions().timeZone` read, for the same reason `relativeTime` takes
 * `now`: a function that reads its environment cannot be tested without
 * mutating that environment, and CI runs in UTC, where an ambient read is
 * indistinguishable from a correct one.
 *
 * Shape is `YYYY-MM-DD HH:mm ZONE` — sortable and scannable down a table
 * column, which `01/08/2026` is not.
 */
export function exactTimestamp(value: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
}
