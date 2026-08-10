"use client";

import { exactTimestamp } from "@/lib/relative-time";
import { useViewerTimeZone } from "@/lib/use-viewer-time-zone";

/**
 * Advisor condition 12. A leaver's open assignments are deliberately NOT
 * auto-returned and deactivation is deliberately NOT blocked on outstanding kit
 * (AM-03-CF-2 — blocking the AM-01 kill-switch on asset state would be a
 * security regression). This marker is what makes that situation visible
 * instead of invisible.
 *
 * `exactTimestamp` directly, NOT <Timestamp>. This is prose, and a <time>
 * mid-sentence buys a machine-readable attribute nothing consumes while
 * splitting the sentence into three text nodes. The shared formatter is still
 * the one being called, so the de-duplication holds; what does not belong here
 * is the element wrapper.
 *
 * An existing test asserts the phrase and the value are adjacent, and it stays
 * green because of this — but that is a consequence, not the reason. A test is
 * not grounds to shape markup; it could have moved to a textContent comparison
 * had the element been worth having. It is not.
 *
 * **A client component since AM-10**, and a whole-paragraph one rather than a
 * `<Timestamp>` dropped into server-rendered prose — which is precisely the
 * element wrapper the paragraph above refuses. The timezone has to come from a
 * hook, the hook needs a client component, so the client boundary goes around
 * the sentence and the markup is unchanged: the same three adjacent text nodes,
 * no new element. `renderToStaticMarkup` runs no effects, so the server render
 * keeps saying UTC and the integration assertion on this sentence keeps
 * passing unchanged.
 */
export function DeactivatedNotice({ deactivatedAt }: { deactivatedAt: Date }) {
  const timeZone = useViewerTimeZone();

  return (
    <p className="border-destructive/50 text-destructive rounded-md border px-3 py-2 text-sm">
      This person&apos;s account was deactivated on{" "}
      {exactTimestamp(deactivatedAt, timeZone ?? "UTC")}. Anything still listed
      under &ldquo;currently held&rdquo; has not been returned.
    </p>
  );
}
