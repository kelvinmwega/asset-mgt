/**
 * THE asset display-name precedence (AM-04 DESIGN §3, advisor condition C3).
 *
 * Every surface that names an asset calls this. It exists because AM-04 made
 * `make` and `model` nullable — the client's legacy export leaves Brand
 * and Model blank on real rows and carries the whole of what an asset IS in
 * `description` — and seven separate call sites were rendering `{make} {model}`
 * directly. After the import, all seven would have rendered an empty string:
 * a register of ~400 assets each labelled with nothing.
 *
 * The precedence is stated ONCE, here, rather than repeated at each site:
 *
 *   1. `make model`  — what a hand-created asset has, and the most specific
 *   2. `description` — what an imported asset has
 *   3. `tag`         — what a barely-filled-in asset has
 *   4. a literal placeholder
 *
 * Step 1 tolerates a PARTIAL pair. An asset with a make and no model is not
 * pushed down to `description`: "HP" beats "HP USB-C G5 Essential Docking
 * Station" for a row whose operator typed the make deliberately, and the
 * blank half is simply absent rather than rendered as "HP null".
 *
 * Step 4 is reachable. `tag` is nullable for ON_ORDER and RETIRED assets (the
 * am02 CHECK exempts exactly those), so an ordered-but-undelivered asset with
 * no make, model or description has no name at all. It gets the placeholder
 * rather than an empty heading — an invisible row cannot be clicked.
 *
 * Client-safe by construction: this module imports nothing. Same rule as
 * `labels.ts` and `asset-lifecycle.ts` — it is rendered inside client
 * components, so dragging the Prisma client into the browser bundle here would
 * be a build regression, not a style question.
 */

/** What naming an asset needs. Structural, so any wider row satisfies it. */
export type AssetNameFields = {
  make: string | null;
  model: string | null;
  description: string | null;
  tag: string | null;
};

/** Rendered when an asset has no make, model, description or tag. */
export const UNNAMED_ASSET = "Unnamed asset";

/**
 * Treat blank-ish values as absent. The import normalises "" to null before it
 * writes, but this is a RENDER path and it also serves rows typed by hand
 * through the form, where a whitespace-only field is a real possibility.
 */
function present(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The name to show for an asset. Never returns an empty string — every branch
 * ends in a non-empty value, so callers can render it without a fallback of
 * their own (which is how the precedence would drift back out of this module).
 */
export function assetDisplayName(asset: AssetNameFields): string {
  const makeModel = [present(asset.make), present(asset.model)]
    .filter((part): part is string => part !== null)
    .join(" ");
  if (makeModel.length > 0) {
    return makeModel;
  }
  return present(asset.description) ?? present(asset.tag) ?? UNNAMED_ASSET;
}
