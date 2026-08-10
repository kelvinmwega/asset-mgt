/**
 * Calendar dates — `Asset.purchasedAt` and `Asset.warrantyUntil` (AM-10).
 *
 * **These are not instants and must never be rendered as one.** A purchase date
 * is a day in a ledger; it did not happen at a time. AM-10 moved every genuine
 * instant into the viewer's timezone, and this module is the boundary that work
 * must not cross: shift a calendar date by a zone and 21 June becomes 20 June
 * for half the world, which is a reconciliation bug against the supplier's
 * invoice, not a display preference.
 *
 * The stored convention is UTC midnight, written by `optionalDate`
 * (`assets/actions.ts`) and by the AM-04 importer (`import-map.ts`). Reading it
 * back in any other zone is what breaks it, so `timeZone: "UTC"` here is
 * load-bearing rather than defensive.
 *
 * **The formatter is constructed per call, deliberately.** Hoisting it to
 * module scope would cache a formatter built under whatever `TZ` happened to be
 * set at import time, which makes the UTC pin untestable: a test that sets `TZ`
 * afterwards changes nothing, so deleting the pin would still pass. Two calls
 * per page render costs nothing and keeps the guard honest.
 */
export function calendarDate(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    // NEVER remove or parameterise. See the docblock — this is the whole point.
    timeZone: "UTC",
  }).format(value);
}

/**
 * The same date in the `YYYY-MM-DD` an `<input type="date">` requires.
 *
 * UTC by construction: `toISOString` has no other mode. It is here rather than
 * inline at the call site so the display form and the edit form read the date
 * off the same rule, and a future change has one place to make it in.
 */
export function calendarDateInputValue(value: Date): string {
  return value.toISOString().slice(0, 10);
}
