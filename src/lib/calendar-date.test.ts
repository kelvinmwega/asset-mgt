import { afterEach, describe, expect, it } from "vitest";

import { calendarDate, calendarDateInputValue } from "./calendar-date";

/**
 * G1 (DESIGN §7). A calendar date never shifts, in either direction, for any
 * viewer.
 *
 * AM-10 moved instants into the viewer's timezone. These fields deliberately
 * did not move, and this is the guard that says so. The zones are chosen to
 * straddle the date line rather than to be realistic: `Pacific/Kiritimati` is
 * UTC+14 and `Pacific/Midway` UTC-11, so a UTC-midnight value read in the
 * ambient zone lands on 22 June in one and 20 June in the other. Nothing
 * subtler would fail loudly enough to notice.
 *
 * These are the extremes on purpose — the real deployment zone (UTC+3) breaks
 * this too, but only for values near midnight, which is exactly the kind of bug
 * that ships green and surfaces months later on one unlucky row.
 */
const UTC_MIDNIGHT = new Date("2026-06-21T00:00:00.000Z");

let originalTz: string | undefined;

afterEach(() => {
  process.env.TZ = originalTz;
});

function withZone(zone: string): void {
  originalTz ??= process.env.TZ;
  process.env.TZ = zone;
}

describe("calendarDate", () => {
  it("reads the same day whatever zone the process is in", () => {
    withZone("Pacific/Kiritimati"); // UTC+14 — would read 22 Jun
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");

    withZone("Pacific/Midway"); // UTC-11 — would read 20 Jun
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");

    withZone("Africa/Nairobi"); // UTC+3 — the real one
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");
  });

  it("reads a date, not a timestamp", () => {
    // "21 Jun 2026", never "21/06/2026" (which the edit form wants) and never
    // with a time component. AM-09 §4.3: this is a value to read, not re-enter.
    expect(calendarDate(UTC_MIDNIGHT)).toMatch(/^\d{1,2} [A-Z][a-z]{2} \d{4}$/);
  });
});

describe("calendarDateInputValue", () => {
  it("round-trips the stored UTC-midnight convention", () => {
    withZone("Pacific/Midway");
    expect(calendarDateInputValue(UTC_MIDNIGHT)).toBe("2026-06-21");
  });

  it("agrees with the displayed date about which day it is", () => {
    // The display grid and the edit form must not disagree — a field that reads
    // "21 Jun 2026" and reopens as 20 June is the bug this pairing prevents.
    withZone("Pacific/Kiritimati");
    expect(calendarDateInputValue(UTC_MIDNIGHT)).toBe("2026-06-21");
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");
  });
});
