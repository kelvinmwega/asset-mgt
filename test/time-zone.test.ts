import { describe, expect, it } from "vitest";

import { pinTimeZone, withTimeZone } from "./time-zone";

/**
 * A test helper with its own test, because the bug it exists to prevent is
 * invisible where it is caused and fails somewhere else entirely.
 *
 * The naive `process.env.TZ = original` restore leaves the literal string
 * `"undefined"` behind whenever `TZ` was unset — which is the normal state on
 * developer machines and in CI. `fileParallelism: false` then carries that
 * broken zone into every later test file in the run. It surfaced here as one
 * intermittent failure in a suite that passed on re-run.
 */
describe("pinTimeZone", () => {
  it("restores an absent TZ by deleting it, not by writing 'undefined'", () => {
    delete process.env.TZ;

    const restore = pinTimeZone("Pacific/Midway");
    expect(process.env.TZ).toBe("Pacific/Midway");

    restore();

    expect("TZ" in process.env).toBe(false);
    expect(process.env.TZ).not.toBe("undefined");
    // The real symptom: an invalid TZ makes the resolved zone `undefined`
    // rather than falling back to the system zone.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBeTruthy();
  });

  it("restores a previously set TZ to its exact value", () => {
    process.env.TZ = "Europe/London";

    pinTimeZone("Pacific/Midway")();

    expect(process.env.TZ).toBe("Europe/London");
    delete process.env.TZ;
  });

  it("actually changes what Intl resolves, or the pin buys nothing", () => {
    delete process.env.TZ;

    const pinned = withTimeZone(
      "Pacific/Midway",
      () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    );

    expect(pinned).toBe("Pacific/Midway");
  });

  it("restores even when the body throws", () => {
    delete process.env.TZ;

    expect(() =>
      withTimeZone("Pacific/Midway", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect("TZ" in process.env).toBe(false);
  });
});
