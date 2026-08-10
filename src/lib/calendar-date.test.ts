import { afterEach, describe, expect, it } from "vitest";

import { pinTimeZone } from "../../test/time-zone";
import { calendarDate, calendarDateInputValue } from "./calendar-date";

/**
 * G1 (DESIGN §7). A calendar date never shifts, in either direction, for any
 * viewer.
 *
 * AM-10 moved instants into the viewer's timezone. These fields deliberately
 * did not move, and this is the guard that says so.
 *
 * **Which zone is load-bearing depends on the fixture, and an earlier version
 * of this docblock got that wrong** (review nit, same class as B3). It claimed
 * a UTC-midnight value "lands on 22 June" in UTC+14. It does not: for a value
 * at UTC midnight only NEGATIVE offsets move the date, so `Pacific/Midway`
 * (UTC−11 → 20 Jun) was the only zone actually proving anything and
 * `Pacific/Kiritimati` and `Africa/Nairobi` were passing controls. A maintainer
 * trusting that comment could have deleted the one line that bites.
 *
 * Rather than weaken the claim, there are now two fixtures so that both
 * directions are genuinely guarded:
 *
 *   UTC_MIDNIGHT   2026-06-21T00:00Z  — shifts BACK a day west of UTC
 *                                       (Midway −11 → 20 Jun)
 *   UTC_LATE_NIGHT 2026-06-21T23:00Z  — shifts FORWARD a day far east of UTC
 *                                       (Kiritimati +14 → 22 Jun)
 *
 * Every zone in the loops below is therefore load-bearing for at least one
 * fixture. The register only ever stores UTC midnight (`optionalDate`,
 * `excelSerialToDate`), so the late-night case is not a shape the app writes —
 * it is here because `calendarDate` is a general function and a guard that only
 * covers the happy fixture is the kind that ships green.
 *
 * Nairobi (UTC+3) is kept as the real deployment zone: it is a control for the
 * midnight fixture and load-bearing for neither, which is exactly why it must
 * not be mistaken for the guard.
 */
const UTC_MIDNIGHT = new Date("2026-06-21T00:00:00.000Z");
const UTC_LATE_NIGHT = new Date("2026-06-21T23:00:00.000Z");

const restorers: Array<() => void> = [];

afterEach(() => {
  // Unwound in reverse so the earliest capture — the real ambient state — is
  // the one restored last, whatever order the zones were pinned in.
  while (restorers.length > 0) restorers.pop()?.();
});

function withZone(zone: string): void {
  restorers.push(pinTimeZone(zone));
}

describe("calendarDate", () => {
  it("does not shift a UTC-midnight date backwards, west of UTC", () => {
    // Midway is THE discriminator here: unpinned it reads 20 Jun.
    withZone("Pacific/Midway"); // UTC−11
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");

    // Controls — these read 21 Jun with or without the pin. They are here to
    // show the pin does not break the common case, NOT as guards.
    withZone("Pacific/Kiritimati"); // UTC+14
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");

    withZone("Africa/Nairobi"); // UTC+3 — the real deployment zone
    expect(calendarDate(UTC_MIDNIGHT)).toBe("21 Jun 2026");
  });

  it("does not shift a late-night date forwards, east of UTC", () => {
    // Kiritimati is THE discriminator here: unpinned it reads 22 Jun.
    withZone("Pacific/Kiritimati"); // UTC+14
    expect(calendarDate(UTC_LATE_NIGHT)).toBe("21 Jun 2026");

    withZone("Africa/Nairobi"); // UTC+3 — also forward, and also bites at 23:00
    expect(calendarDate(UTC_LATE_NIGHT)).toBe("21 Jun 2026");
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
