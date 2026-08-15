import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * THE register search predicate (AM-07, issue #7).
 *
 * `assetSearchWhere(q)` takes a string and returns a clause over ASSET
 * ATTRIBUTES — tag, serial, make, model, description, and the category's name.
 * Nothing else.
 * It has no `Role` parameter, and that absence is the whole security design of
 * this feature: a signature rather than a comment.
 *
 * ## Why there is no role argument
 *
 * The obvious shape for "search staff names as well, but only for roles allowed
 * to see who holds what" is a conditional where-fragment, gated on the same
 * role predicate the register's holder column already branches on:
 * `canView…(role) ? {…} : {}`. That is convention plus a tripwire, not
 * structure. Delete the ternary and this module still compiles, still
 * typechecks, and still passes everything except the one bespoke test somebody
 * remembered to write.
 *
 * The risk it would be guarding is not cosmetic either. A holder-name predicate
 * discloses who holds what even when no name is rendered anywhere, because the
 * RESULT SET is itself the disclosure: a reader types "grace", gets four
 * laptops back, and has learnt exactly what the register refuses to show them.
 * Rendering less does not help; the filter has to not exist.
 *
 * So the branch does not exist here. `/assets?q=` is asset-attribute-only and
 * therefore identical for every role — a property a test can assert head-on
 * (search the same term as ADMIN_IT and as STAFF_RO, compare the ids) and one
 * that fails loudly for ANY role-dependent search behaviour, not merely for the
 * one variant we thought of. The "who has Grace's laptop" lookup belongs
 * instead on a role-gated `/people` index, where route-level gating is the
 * guard — the only rung in this design that actually holds. That is a separate
 * issue and a separate consult.
 *
 * **No holder-name predicate may be added to `/assets` without a new advisor
 * ruling.** The T3 ruling on issue #7 is explicit about it.
 *
 * ## Why event notes are absent
 *
 * `AssetEvent.notes` is operator-typed free text rendered to all four roles,
 * and CLAUDE.md names it as the one place the no-staff-data-in-event-tables
 * rule can be bypassed — by a human typing a name into a box. Making it
 * searchable would hand every reader the name index this application
 * deliberately does not keep. Its absence is guarded behaviourally, not by
 * grep: `src/app/(app)/assets/page.integration.test.tsx` seeds an event note
 * containing a nonce and asserts that searching that nonce returns zero assets
 * for every role, including ADMIN_IT. A grep-guard would pass the moment
 * somebody reached notes through a relation filter spelled differently.
 *
 * ## Auditing this module
 *
 * Search this file for the two holder-side model names — the one carrying staff
 * PII and the one linking it to an asset. Both are named in the CLAUDE.md
 * non-negotiable governing what a STAFF_RO reader may see; neither is written
 * out anywhere above, because a docblock quoting the grep would defeat it.
 * Zero hits is the invariant.
 */

/**
 * Collapse runs of whitespace and trim, before anything is matched.
 *
 * `contains` is whitespace-sensitive (LEARNINGS §Zod), so a tag pasted out of a
 * spreadsheet as `"ThinkPad  X1 "` matches nothing at all against a model
 * stored as `"ThinkPad X1"` — a search that silently returns an empty register
 * for input that looks correct on screen.
 *
 * Exported because the page normalises at the PARSE boundary, so that one
 * string feeds the predicate, the exact-tag lookup, every link on the page and
 * the input's own value. `assetSearchWhere` applies it again regardless: a
 * caller who has not normalised is precisely the case that produces the silent
 * empty result set, and the operation is idempotent, so the second application
 * costs nothing.
 */
export function normaliseSearchTerm(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * The `?q=` clause: asset attributes only, the same for every role.
 *
 * A reviewer who sees a `role` parameter grow onto this signature should reject
 * the change without reading further — see the module docblock.
 */
export function assetSearchWhere(q: string): Prisma.AssetWhereInput {
  const contains = normaliseSearchTerm(q);

  // An empty normalised term is NO PREDICATE, not a predicate that matches
  // everything. `/assets` never reaches this today — its parse boundary turns a
  // whitespace-only `q` into `undefined` — but this is an exported helper, so
  // its contract has to hold for callers that have not done that.
  //
  // What `contains: ""` compiles to is `ILIKE '%%'`, and per-column that is not
  // the harmless no-op it looks like: `NULL ILIKE '%%'` is NULL, not TRUE, so
  // the branch drops the row. Measured against real Postgres, a lone
  // `{ tag: { contains: "" } }` does exclude an untagged asset.
  //
  // The OR below happens to mask that, and AM-04 MOVED WHICH COLUMN DOES THE
  // MASKING. This comment previously said `make` and `model` are non-nullable
  // so their branches match every row; both became nullable in the AM-04
  // migration, and that sentence is now false. The masking did not disappear —
  // it moved to `category.name`, which is non-nullable behind a required FK, so
  // its branch still matches every row and untagged assets still survive.
  //
  // Which is exactly why this guard IS NOT RESULT-SET-FALSIFIABLE, and why no
  // test in this repo claims to red-prove it (advisor condition AM-04-C26).
  // Delete the `return {}` and every assertion still passes, because the
  // Category branch produces the same rows. Writing a test that appears to
  // prove it would be worse than having none: it would report green for a
  // guard it never exercised. What defends it is this comment plus the review
  // rule above — narrow the OR to nullable columns only and an empty search
  // would start silently hiding exactly the assets nobody has tagged yet.
  //
  // It is also six ILIKEs and a LEFT JOIN onto Category to express "no
  // filter", which the planner cannot simplify away.
  if (contains === "") return {};

  // `mode: "insensitive"` on every branch. Postgres LIKE is case-sensitive, so
  // without it a search for `thinkpad` misses every `ThinkPad` the importer
  // wrote, and the feature only works for readers who type the way the CSV did.
  //
  // No trigram index, deliberately: `ILIKE '%…%'` is a Seq Scan, and at 402
  // rows today (a client projection near 4,000) that is the correct plan.
  // Revisit `pg_trgm` + GIN somewhere above ~50k rows, and verify with EXPLAIN
  // ANALYZE rather than assuming (LEARNINGS §Prisma).
  return {
    OR: [
      { tag: { contains, mode: "insensitive" } },
      { serial: { contains, mode: "insensitive" } },
      { make: { contains, mode: "insensitive" } },
      { model: { contains, mode: "insensitive" } },
      // AM-04. WITHOUT THIS BRANCH `?q=` SILENTLY DIES AT CUTOVER: the legacy
      // export leaves Brand and Model blank on every row, so an imported
      // register of ~400 assets would be searchable by tag and serial and by
      // nothing a human remembers. `description` is the only name those rows
      // have.
      //
      // It is an ASSET ATTRIBUTE, so it belongs here and the no-role-parameter
      // rule above is untouched. The sharp edge, named rather than left for a
      // reader to find: `description` is legacy free text and "Lindah's laptop"
      // is a normal thing to find in an asset register — which would make a
      // staff name findable by every role, the bypass this module exists to
      // prevent. It is bounded and `AssetEvent.notes` is not: description is
      // correctable through `updateAssetWithEvent`, notes is append-only. The
      // import's own scan for staff names in this column is what makes the
      // problem visible rather than theoretical.
      { description: { contains, mode: "insensitive" } },
      { category: { name: { contains, mode: "insensitive" } } },
    ],
  };
}
