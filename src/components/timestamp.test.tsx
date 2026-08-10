import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pinTimeZone } from "../../test/time-zone";
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

let restoreTz: () => void;

beforeEach(() => {
  restoreTz = pinTimeZone(VIEWER_ZONE);
});

afterEach(() => {
  restoreTz();
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

  /**
   * C6 (advisor). The same assertion as above, widened to the axes that could
   * plausibly move it: two zones of OPPOSITE sign, both variants, and both the
   * server and client renders. The rendered text differs across all four
   * combinations; `dateTime` must be byte-identical in every one.
   *
   * Opposite signs on purpose — the advisor's point that the display and input
   * hazards break under opposite offsets applies here too, and a pair of
   * same-sign zones would leave half the space untested.
   */
  it("keeps dateTime byte-identical across zones, variants and renderers", () => {
    const EXPECTED = "2026-07-01T09:30:00.000Z";
    const rendered = new Set<string>();

    for (const zone of ["Africa/Nairobi", "America/Los_Angeles"]) {
      const restore = pinTimeZone(zone);
      try {
        for (const element of [
          <Timestamp key="e" value={VALUE} exact />,
          <Timestamp key="r" value={VALUE} now={NOW} />,
        ]) {
          // Server: no effects, so this is the UTC-fallback path.
          expect(renderToStaticMarkup(element)).toContain(
            `dateTime="${EXPECTED}"`,
          );

          // Client: effects run, so this is the viewer-local path.
          const { container, unmount } = render(element);
          const time = container.querySelector("time");
          expect(time).toHaveAttribute("datetime", EXPECTED);
          rendered.add(time?.textContent ?? "");
          unmount();
        }
      } finally {
        restore();
      }
    }

    // The control, and it must be an EXACT count (review B4).
    //
    // `toBeGreaterThan(1)` was vacuous: the relative variant renders
    // "3 days ago" in both zones, so a component that ignored the viewer's zone
    // entirely still produced two distinct strings — the exact value and the
    // relative phrase — and satisfied it. The two VARIANTS alone cleared the
    // bar; the zone never entered into it.
    //
    // Three is the honest number, and the arithmetic is worth stating because
    // it is what makes the control bite:
    //
    //   Nairobi  exact -> "2026-07-01 12:30 GMT+3"   |  relative -> "3 days ago"
    //   LA       exact -> "2026-07-01 02:30 GMT-7"   |  relative -> "3 days ago"
    //
    // Two distinct exact values plus one shared relative phrase. A zone-blind
    // component collapses the two exact values into one and yields 2.
    expect(rendered.size).toBe(3);
  });
});
