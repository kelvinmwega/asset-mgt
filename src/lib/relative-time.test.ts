import { describe, expect, it } from "vitest";

import { exactTimestamp, relativeTime } from "./relative-time";

const now = new Date("2026-08-02T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  it.each([
    [30 * MINUTE, "under an hour ago"],
    [HOUR, "1 hour ago"],
    [5 * HOUR, "5 hours ago"],
    [DAY, "yesterday"],
    [3 * DAY, "3 days ago"],
    [29 * DAY, "29 days ago"],
    [30 * DAY, "1 month ago"],
    [90 * DAY, "3 months ago"],
    [359 * DAY, "11 months ago"],
    // The window that used to render "0 years ago". `days / 30` reaches 12 at
    // 360 days while `days / 365` is still 0, so the two units disagreed for
    // five days a year and the disagreement was user-visible. Every unit now
    // cascades from the one below it, which is what makes the boundary a single
    // place rather than two that can drift.
    [360 * DAY, "1 year ago"],
    [364 * DAY, "1 year ago"],
    [365 * DAY, "1 year ago"],
    [400 * DAY, "1 year ago"],
    [800 * DAY, "2 years ago"],
  ])("renders %i ms ago as %s", (elapsed, expected) => {
    expect(relativeTime(ago(elapsed), now)).toBe(expected);
  });

  it("never renders a zero quantity", () => {
    // The failure this pins is not "360 days is wrong" but the CLASS of it: a
    // phrase like "0 years ago" tells the reader nothing and looks like a bug
    // in the record, not in the formatter. Swept across two years of daily
    // values so a future boundary change cannot reintroduce it somewhere else.
    for (let days = 0; days <= 730; days++) {
      const phrase = relativeTime(ago(days * DAY), now);
      expect(phrase, `${days} days`).not.toMatch(/\b0\b/);
    }
  });

  it("never says a negative amount of time", () => {
    // A record dated slightly ahead of the server — clock skew between the app
    // and the database is enough. "in -3 days" is the kind of string that makes
    // a reader distrust the whole page.
    const future = new Date(now.getTime() + 5 * MINUTE);
    expect(relativeTime(future, now)).toBe("just now");
  });

  it("does not report false precision inside the hour", () => {
    // 40 minutes and 50 minutes must read the same: the difference changes no
    // decision, and a number here invites someone to reconcile against it,
    // which is what the exact timestamp is for.
    expect(relativeTime(ago(40 * MINUTE), now)).toBe(
      relativeTime(ago(50 * MINUTE), now),
    );
  });

  /**
   * G6 (DESIGN §7). AM-10 localised the exact timestamp and deliberately left
   * this alone: elapsed time between two instants is the same number of
   * milliseconds in every zone. Its "yesterday" is an elapsed-hours bucket, not
   * a calendar-day computation, so there is no correct zone to give it — and a
   * `timeZone` parameter added here would be a silent invitation to make it
   * one.
   */
  it("is zone-independent", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      const east = relativeTime(ago(3 * DAY), now);
      process.env.TZ = "Pacific/Midway"; // UTC-11
      expect(relativeTime(ago(3 * DAY), now)).toBe(east);
      expect(east).toBe("3 days ago");
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("exactTimestamp", () => {
  // 21:21 UTC is 00:21 the NEXT DAY in Nairobi — the date rolls, not just the
  // clock. A formatter that sliced the ISO string and swapped the label would
  // pass a same-day fixture and fail this one.
  const INSTANT = new Date("2026-08-01T21:21:33.500Z");

  it("formats in the zone it is given, rolling the date where it must", () => {
    expect(exactTimestamp(INSTANT, "UTC")).toBe("2026-08-01 21:21 UTC");
    expect(exactTimestamp(INSTANT, "Africa/Nairobi")).toBe(
      "2026-08-02 00:21 GMT+3",
    );
    expect(exactTimestamp(INSTANT, "America/New_York")).toBe(
      "2026-08-01 17:21 GMT-4",
    );
  });

  /**
   * G5 (DESIGN §7). The zone is never omitted.
   *
   * AM-09 rendered every viewer the same UTC string, on the reasoning that an
   * audit trail rendering differently per viewer is not one. AM-10 renders per
   * viewer, and this is half of what replaces that guarantee: a screenshot that
   * does not name its own clock cannot be reconciled, and two admins comparing
   * screens could not tell a timezone difference from a data difference. The
   * other half is the UTC ISO in `<time dateTime>` (see timestamp.test.tsx).
   *
   * Red-proven by deleting `timeZoneName: "short"` from the formatter.
   */
  it("always names the zone, and different zones read differently", () => {
    const rendered = ["UTC", "Africa/Nairobi", "America/New_York"].map((zone) =>
      exactTimestamp(INSTANT, zone),
    );

    for (const value of rendered) {
      // A trailing zone token, always: "… 21:21 UTC", never a bare "… 21:21".
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/);
    }
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  /**
   * The zone comes from the argument and NOWHERE else.
   *
   * This is the guard CI cannot fake. GitHub Actions runners have no `TZ` set,
   * so they run in UTC, where an accidental ambient
   * `resolvedOptions().timeZone` read is indistinguishable from a correct
   * explicit one — the test would pass in CI forever while being wrong on every
   * developer machine and in every browser. Pinning the process zone to
   * something far from both UTC and Nairobi is what makes the assertion mean
   * anything.
   */
  it("ignores the ambient process timezone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      expect(exactTimestamp(INSTANT, "UTC")).toBe("2026-08-01 21:21 UTC");
      process.env.TZ = "Pacific/Midway"; // UTC-11
      expect(exactTimestamp(INSTANT, "UTC")).toBe("2026-08-01 21:21 UTC");
    } finally {
      process.env.TZ = original;
    }
  });

  it("renders midnight as 00:xx, never 24:xx", () => {
    // `hour12: false` renders midnight as "24:00" under some locale/engine
    // pairs; `hourCycle: "h23"` is why this holds.
    expect(
      exactTimestamp(new Date("2026-08-01T21:00:00Z"), "Africa/Nairobi"),
    ).toBe("2026-08-02 00:00 GMT+3");
  });
});
