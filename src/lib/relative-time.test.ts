import { describe, expect, it } from "vitest";

import { pinTimeZone, withTimeZone } from "../../test/time-zone";
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
   * G6 (DESIGN §7, upgraded per advisor C3). AM-10 localised the exact
   * timestamp and deliberately left this alone: elapsed time between two
   * instants is the same number of milliseconds in every zone.
   *
   * **This guards a property, not an absence** — an earlier version of this
   * test compared two zones on a value three days old, which no realistic
   * mutant fails, and it was wrongly recorded as un-red-provable. The mutant
   * worth defending against is a future "make `yesterday` mean calendar
   * yesterday" refactor, i.e. local calendar-day arithmetic instead of elapsed
   * milliseconds.
   *
   * The fixture is what makes it bite: three hours before `now`, positioned so
   * it straddles local midnight in Nairobi and does not in Los Angeles.
   *
   *   value 20:00Z, now 23:00Z
   *   Nairobi (+3):     23:00 -> 02:00 next day   local day delta 1
   *   Los Angeles (-7): 13:00 -> 16:00 same day   local day delta 0
   *
   * A calendar-day implementation therefore says "yesterday" in Nairobi and
   * "3 hours ago" in Los Angeles. Red-proven by making `relativeTime` compare
   * local calendar days: the Nairobi assertion fails.
   */
  it("is zone-independent, even across a local midnight", () => {
    const straddleNow = new Date("2026-06-21T23:00:00.000Z");
    const threeHoursBefore = new Date("2026-06-21T20:00:00.000Z");

    const nairobi = withTimeZone("Africa/Nairobi", () =>
      relativeTime(threeHoursBefore, straddleNow),
    );
    const losAngeles = withTimeZone("America/Los_Angeles", () =>
      relativeTime(threeHoursBefore, straddleNow),
    );

    expect(nairobi).toBe("3 hours ago");
    expect(losAngeles).toBe("3 hours ago");
    expect(nairobi).toBe(losAngeles);
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
    for (const ambient of ["Pacific/Kiritimati", "Pacific/Midway"]) {
      // UTC+14, UTC-11
      expect(withTimeZone(ambient, () => exactTimestamp(INSTANT, "UTC"))).toBe(
        "2026-08-01 21:21 UTC",
      );
    }
  });

  /**
   * C2 (advisor). The offset is computed per instant, not once per zone.
   *
   * The browser check could not have caught this: Nairobi has no DST, so an
   * offset hoisted out of the per-row formatter and reused for every row would
   * have looked perfect there and been wrong for half the year anywhere that
   * observes it. New York in January and July is the discriminating pair.
   *
   * Red-proven by computing the offset once from a fixed date and reusing it
   * for every value — a mutation rather than a deletion, because what is being
   * guarded is that `Intl` is consulted per value at all.
   */
  it("applies the offset per instant, so DST is honoured", () => {
    const winter = exactTimestamp(
      new Date("2026-01-15T12:00:00Z"),
      "America/New_York",
    );
    const summer = exactTimestamp(
      new Date("2026-07-15T12:00:00Z"),
      "America/New_York",
    );

    expect(winter).toBe("2026-01-15 07:00 GMT-5");
    expect(summer).toBe("2026-07-15 08:00 GMT-4");
  });

  /**
   * C1 (advisor). The zone label is an OFFSET, never a locale-dependent
   * abbreviation.
   *
   * `short` returns `CST` for America/Chicago under en-US — a string that is
   * simultaneously China Standard Time (+8), US Central (-6) and Cuba. It
   * happens to return `GMT-6` under the en-GB this app pins, so the bug is
   * latent rather than absent, and "display in the user's timezone" is exactly
   * the change that invites someone to reach for the viewer's locale too.
   *
   * Red-proven by switching the formatter to `short`: under en-US this test
   * fails. It is asserted structurally rather than against a literal so it
   * keeps holding as CLDR data changes.
   */
  it("labels every zone with an unambiguous offset", () => {
    for (const zone of [
      "America/Chicago",
      "America/New_York",
      "Asia/Shanghai",
      "Africa/Nairobi",
    ]) {
      const label = exactTimestamp(INSTANT, zone).split(" ").at(-1);
      expect(label).toMatch(/^GMT[+-]\d{1,2}(:\d{2})?$/);
    }
  });

  /**
   * Review finding B1. A missing zone can NEVER silently become the ambient one.
   *
   * `Intl` does not reject `{ timeZone: undefined }` — it treats the option as
   * absent and falls through to the machine's zone. Combined with a poisoned
   * ambient `TZ` (the `"undefined"` string this suite's own helper exists to
   * prevent, see `test/time-zone.ts`) that renders `GMT+0`: a value that looks
   * deliberate, is not, and differs from the `UTC` every SSR assertion expects.
   *
   * Both halves are reproduced here rather than described. The zone is forced
   * through the argument, so this holds whatever the caller does — the `??
   * "UTC"` at the call sites is now a second line of defence, not the only one.
   *
   * Red-proven by removing the `|| "UTC"` from `exactTimestamp`.
   */
  it("falls back to UTC for a missing zone, even under a poisoned ambient TZ", () => {
    const restore = pinTimeZone("undefined"); // exactly the poisoned state
    try {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBeUndefined();

      for (const missing of [undefined, null, ""]) {
        expect(exactTimestamp(INSTANT, missing as unknown as string)).toBe(
          "2026-08-01 21:21 UTC",
        );
      }
    } finally {
      restore();
    }
  });

  it("names the UTC fallback UTC, not GMT+0", () => {
    // The one deliberate exception to the offset rule, and the reason the four
    // pre-existing SSR assertions still pass unchanged (advisor C7).
    expect(exactTimestamp(INSTANT, "UTC")).toBe("2026-08-01 21:21 UTC");
  });

  it("renders midnight as 00:xx, never 24:xx", () => {
    // `hour12: false` renders midnight as "24:00" under some locale/engine
    // pairs; `hourCycle: "h23"` is why this holds.
    expect(
      exactTimestamp(new Date("2026-08-01T21:00:00Z"), "Africa/Nairobi"),
    ).toBe("2026-08-02 00:00 GMT+3");
  });
});
