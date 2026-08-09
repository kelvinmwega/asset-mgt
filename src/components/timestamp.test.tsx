import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Timestamp } from "./timestamp";

const VALUE = new Date("2026-07-01T09:30:00.000Z");
const NOW = new Date("2026-07-04T09:30:00.000Z");

/**
 * The viewer's zone reaches the component through
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`, which follows
 * `process.env.TZ`. Pinning it is not tidiness: CI has no `TZ` and so runs in
 * UTC, where "renders in the viewer's zone" and "renders in UTC" produce
 * identical output and every assertion below would pass against either. The
 * whole point of AM-10 is only observable from a zone that is not UTC.
 *
 * Nairobi (UTC+3) is the real deployment zone, and 09:30 UTC lands at 12:30
 * there — same day, so the date is held constant and only the clock moves,
 * which keeps these assertions about the zone rather than about date rollover
 * (relative-time.test.ts covers rollover).
 */
const VIEWER_ZONE = "Africa/Nairobi";
const IN_VIEWER_ZONE = "2026-07-01 12:30 GMT+3";
const IN_UTC = "2026-07-01 09:30 UTC";

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
  process.env.TZ = VIEWER_ZONE;
});

afterEach(() => {
  process.env.TZ = originalTz;
});

describe("Timestamp", () => {
  it("renders the exact value in the viewer's zone, naming the zone", () => {
    render(<Timestamp value={VALUE} exact />);
    expect(screen.getByText(IN_VIEWER_ZONE)).toBeInTheDocument();
  });

  it("renders a relative phrase by default, with the exact value one hover away", () => {
    render(<Timestamp value={VALUE} now={NOW} />);
    const el = screen.getByText("3 days ago");
    expect(el).toHaveAttribute("title", IN_VIEWER_ZONE);
  });

  /**
   * G4 (DESIGN §7). The server render, the no-JS render and the first client
   * render are UTC and say so.
   *
   * `renderToStaticMarkup` runs no effects, so `useViewerTimeZone` never
   * resolves — which is exactly the state those three renders are in. This is
   * asserted from a process pinned to Nairobi, so "it happened to be UTC
   * anyway" is excluded: the component must fall back to UTC because it does
   * not yet know the viewer's zone, not because the environment is UTC.
   *
   * Red-proven by resolving the zone in a `useState` initialiser instead of an
   * effect — the LEARNINGS §Frontend anti-pattern this hook is shaped to avoid.
   * That also reintroduces a hydration mismatch, which this test would not
   * catch on its own; the two failures share one cause.
   */
  it("falls back to UTC where the viewer's zone is not yet known", () => {
    const markup = renderToStaticMarkup(<Timestamp value={VALUE} exact />);

    expect(markup).toContain(IN_UTC);
    expect(markup).not.toContain("GMT+3");
  });

  /**
   * G3 (DESIGN §7). The machine-readable value is UTC ISO-8601 in both
   * variants, whatever the viewer's zone.
   *
   * This attribute is what makes localised display text safe to ship in an
   * audit register: the rendered string moves with the reader, this does not,
   * and it is the fixed point anything reconciling against another system uses.
   * Asserted under a non-UTC viewer zone, or it asserts nothing.
   *
   * Red-proven by pointing `dateTime` at the localised string.
   */
  it("always carries a UTC machine-readable dateTime, whichever variant", () => {
    const { rerender } = render(<Timestamp value={VALUE} exact />);
    expect(screen.getByText(IN_VIEWER_ZONE)).toHaveAttribute(
      "datetime",
      "2026-07-01T09:30:00.000Z",
    );
    rerender(<Timestamp value={VALUE} now={NOW} />);
    expect(screen.getByText("3 days ago")).toHaveAttribute(
      "datetime",
      "2026-07-01T09:30:00.000Z",
    );
  });
});
