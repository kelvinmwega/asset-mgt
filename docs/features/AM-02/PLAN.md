# AM-02 Implementation Plan — Asset Register and Lifecycle

**Tier: T2** — multi-file feature on the existing, advisor-reviewed `requireRole` chokepoint. The
schema change is additive plus one FK tightening the advisor already ruled on as an AM-01
carry-forward. No new auth/secret/PII/deletion surface, and the delete decision below keeps it
that way.

## Context

AM-01 shipped identity: seeded staff, magic-link sign-in, four DB-read roles, and an append-only
`UserEvent` audit trail. The app can say _who you are_ but holds no assets — `Asset`, `AssetEvent`,
`Category`, and `Site` exist in `prisma/schema.prisma` as scaffold shapes with no write path.

AM-02 opens that write path. It is the story the rest of Milestone 1 stands on: AM-03 (assignment)
and AM-04 (the legacy register import that lets the client cancel the subscription) both list AM-02 as
a hard dependency. The outcome: procurement and IT can record an asset from order through delivery,
tagging, repair, and retirement, with every change appended to an immutable history — the register
reflects reality at every stage, and the audit trail can answer "what happened to this laptop"
without a DBA.

### Decisions taken with Kelvin before planning

1. **No hard delete.** `RETIRED` is the delete. No `db.asset.delete()` path is ever generated —
   deleting an Asset would sever its `AssetEvent` history, the same argument that made User
   deactivation a flag in AM-01. _Deferred:_ un-retiring a mistakenly-retired asset (`RETIRED` is
   terminal; a `CORRECTION`-event path is post-MVP).
2. **Reference data gets a small admin screen** — seed script _and_ `/admin/reference` (ADMIN_IT
   only) so the client can add a category or site without a deploy.
3. **The tag rule is a DB CHECK constraint**, with an app-level guard for the friendly message
   (LEARNINGS §Prisma: enforce trust gates in SQL, not application code).

## Lifecycle (the contract)

Per `docs/intake/asset-mgt/SOLUTION.md`:

```
ON_ORDER ──tag──> IN_STOCK <──> ASSIGNED
                     ↑             │
                     └── IN_REPAIR ┘        any ──> RETIRED (terminal)
```

- `ON_ORDER → IN_STOCK` is the **tag-on-delivery** flow: requires a tag, rejected without one.
- `IN_STOCK → ASSIGNED` and `ASSIGNED → IN_STOCK` are in the map but have **no AM-02 UI** — AM-03
  owns assignment. The map is complete now so AM-03 adds no lifecycle logic.
- `{IN_STOCK, ASSIGNED} → IN_REPAIR → IN_STOCK` is the repair loop (client's reality is
  repair-heavy — first-class, not an edge case).
- Everything → `RETIRED`. Nothing leaves `RETIRED`.

## Tasks

Task 1 is foundational and runs first in the main thread. Tasks 2–5 (asset core) and task 6
(reference data) are independent workstreams → two parallel `engineer` subagents on branch
`feat/am-02`, sequenced commits. One conventional commit per task.

### 1. Schema + migration — `am02_asset_lifecycle` (main thread, first)

`prisma/schema.prisma`:

- `AssetEvent.actor` relation gains `onDelete: Restrict` — **the AM-01 advisor carry-forward**,
  now that the asset write path opens. Deleting a User must never silently blank audit attribution.
- Indices for the register list's filters: `@@index([status])`, `@@index([categoryId])`,
  `@@index([siteId])` on `Asset`.

Hand-edited into the generated migration SQL (Prisma has no CHECK primitive):

```sql
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_tag_required_when_tracked"
  CHECK ("status" IN ('ON_ORDER','RETIRED') OR "tag" IS NOT NULL);
```

`RETIRED` is exempt so dead-on-arrival kit can be retired without ever being tagged.
**AM-04 implication to carry forward:** the import fails loudly on a tagless in-stock row rather
than landing it untagged — consistent with "unmapped rows are reported, never silently dropped".

> ⚠️ `.env` holds the **production** `DATABASE_URL` and the Prisma CLI autoloads it (AM-01 retro
> §5). Every local DB command in this story explicitly overrides `DATABASE_URL` to the Docker
> Postgres URL. No bare `pnpm db:migrate`.

### 2. Lifecycle core — `src/lib/asset-lifecycle.ts`

Pure, dependency-free module: the transition map above as data, `canTransition(from, to)`,
`assertTransition(from, to)` throwing a typed `IllegalTransitionError`, and `tagRequiredFor(status)`
mirroring the CHECK constraint. Pure means the 5×5 matrix is a fast unit test, not a DB round-trip.

### 3. Write layer — `src/lib/asset-admin.ts`

Mirrors `src/lib/user-admin.ts` exactly — same file shape, same transaction discipline. Every
mutation writes its `AssetEvent` **in the same transaction**; a mutation that commits without its
audit row must be impossible.

- `createAssetWithEvent` → `CREATED` event, `toStatus` = initial status (`ON_ORDER`, or `IN_STOCK`
  when a tag is supplied — not everything is ordered through the tool).
- `updateAssetWithEvent` → `UPDATED` event (field edits; status is not editable here).
- `transitionAssetStatus` → `assertTransition` first, then `STATUS_CHANGED` with `fromStatus`/
  `toStatus`, optional `notes` and `condition` (repair send/return captures both).

Reserved, untouched by AM-02: `ASSIGNED`/`RETURNED` (AM-03), `IMPORTED` (AM-04), `CORRECTION`.

### 4. Server actions — `src/app/assets/actions.ts`

`await requireRole(...)` is the **first statement** of every action, no exceptions.

| Action                                                                                                | Gate                                                            |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `createAsset`, `updateAsset`, `receiveAndTagAsset`, `sendToRepair`, `returnFromRepair`, `retireAsset` | `requireRole("ADMIN_IT", "PROCUREMENT")`                        |
| register + detail pages (read)                                                                        | `requireRole("ADMIN_IT", "PROCUREMENT", "FINANCE", "STAFF_RO")` |

Zod boundary schemas follow `src/app/admin/users/actions.ts`: `.preprocess` normalises _before_
validation, empty string → `null` for optional fields, `.min(0)` not `.positive()` for
`purchasePrice`. P2002 (duplicate tag) and the CHECK violation map to friendly messages;
`IllegalTransitionError` maps to "That status change isn't allowed"; everything else rethrows.

### 5. UI — `/assets`

- `src/app/assets/page.tsx` — register table (tag, make/model, category, status, site, condition).
  Filters by status/category/site via `searchParams`, parsed with `safeParse` so a malformed link
  renders default state, not a 500; empty-string filters guarded by truthiness before they reach
  the WHERE clause.
- `src/app/assets/new/page.tsx` + `asset-form.tsx` — create form.
- `src/app/assets/[id]/page.tsx` — detail, edit form, lifecycle action buttons (rendered only for
  write roles; the server gate is what enforces it), and the `AssetEvent` history newest-first.
- `src/app/page.tsx` — link to the register for every role.

Hand-written shadcn-style components reusing `src/components/ui/*` (Button, Input, Label, Select,
Table). No shadcn CLI — Tailwind v4 CSS validation bug, LEARNINGS §Next.js.

Two gotchas for whoever builds this: Prisma `Decimal` is not serialisable across the server/client
boundary — convert `purchasePrice` to a string in the server component; and `params` is async in
Next 15 `[id]` pages (a non-async signature typechecks and fails the build).

### 6. Reference data — seed + `/admin/reference` (parallel workstream)

- `scripts/seed-reference.ts`, run as `pnpm db:seed:reference` (tsx + dotenv-cli, same as
  `seed-staff.ts` — tsx does not autoload env files). Idempotent upsert by unique name; reads
  `type,name` rows from `REFERENCE_CSV`, defaulting to a committed
  `scripts/reference.example.csv` with a generic IT category list.
- `src/app/admin/reference/page.tsx` + `actions.ts` — `requireRole("ADMIN_IT")` first statement;
  add and rename Category and Site. Rename, not delete: a category with assets must not vanish.

### 7. Docs

README: `pnpm db:seed:reference` in the quickstart and the prod runbook. `CLAUDE.md`: the tag CHECK
constraint, `RETIRED`-not-delete, and the `asset-lifecycle.ts` location as non-negotiables.

## Verification

**Test approach (T2):** targeted tests run locally, full suite in CI.

Unit — `src/lib/asset-lifecycle.test.ts`: the full 5×5 transition matrix plus the tag-required rule.

Real DB (`describe.skipIf(!process.env.TEST_DATABASE_URL)`, following
`src/lib/authz.integration.test.ts`) — mocks cannot guard these seams:

- `src/lib/asset-admin.integration.test.ts`
  - `CREATED` event present on success; **absent on an induced failure** (atomicity).
  - Illegal transitions rejected end-to-end (`ON_ORDER → ASSIGNED`, `RETIRED → IN_STOCK`).
  - Tag-on-delivery: `ON_ORDER → IN_STOCK` rejected without a tag, succeeds with one and writes
    `STATUS_CHANGED` carrying from/to.
  - Duplicate tag rejected (P2002); two untagged `ON_ORDER` assets coexist.
  - **The CHECK constraint proven at the DB layer** — a raw SQL `UPDATE` bypassing the app entirely
    must fail. If this only fails through the app layer, the constraint isn't doing the work.
- `src/app/assets/actions.integration.test.ts` — role matrix: `ADMIN_IT`/`PROCUREMENT` allowed on
  each write action, `FINANCE`/`STAFF_RO` denied, all four allowed on reads.
- `src/app/admin/reference/actions.integration.test.ts` — `ADMIN_IT` only.

**Falsifiability gate (LEARNINGS §Testing, and AM-01's headline surprise):** the CHECK-constraint
test and the transition-guard test must each be proven red once with the production line deleted.
A guard that cannot go red is decoration. The engineers report this explicitly, not as a claim.

**Commands** (each with an explicit `DATABASE_URL` override — never bare):
`pnpm lint`, `pnpm typecheck`, `pnpm test` with `TEST_DATABASE_URL` set, and `pnpm build` with
**zero env populated** (the env-chokepoint invariant CI proves every run).

**End-to-end smoke against local Docker Postgres:** seed reference data → sign in as admin →
create an `ON_ORDER` asset → receive-and-tag it (confirm the tagless attempt is rejected) → send to
repair with a condition note → return from repair → retire → confirm the detail page's history
shows five events in order, and that a `FINANCE` session can read the register but sees no write
controls and is rejected by the action if it posts one anyway.

**Gates:** `reviewer` subagent on the full diff against the ACs and this plan, then PR. CI runs the
full suite. Blocking findings route back through the fix path; the same finding blocking twice is
an impasse for Kelvin, not a loop.

**Escalation triggers → stop, tell Kelvin, re-plan at T3:** a hard-delete requirement resurfacing,
the CHECK constraint forcing a data migration over existing rows, or any new auth/PII surface.

## Out of scope (named, not forgotten)

Assignment and returns (AM-03) · legacy register import (AM-04) · CSV/finance export (AM-05) ·
global search (AM-07) · un-retiring via a `CORRECTION` event · asset photos and attachments.

## Carry-forwards out of AM-02 (surfaced in review, deliberately not fixed here)

**Into AM-04 (import) — both must be in its plan before implementation starts:**

- **`INITIAL_ASSET_STATUSES` cannot express a legacy import.** `createAssetWithEvent` accepts only
  `ON_ORDER` and `IN_STOCK`, so legacy rows arriving as `ASSIGNED`, `IN_REPAIR` or `RETIRED` cannot
  be created at all. The tempting workaround — create, then transition into place — would fabricate
  `STATUS_CHANGED` events for transitions that never happened, corrupting the audit trail the
  register exists to provide. AM-04 needs a distinct `importAssetWithEvent` writing the reserved
  `IMPORTED` event with the terminal status directly.
- **The register has no pagination.** Fine at AM-02's volumes; ~400 imported assets render as a
  single unbounded table.

**Into AM-03 (assignment):**

- **`updateAssetWithEvent` is an unlocked read-then-write.** Safe for the tag invariant only,
  because the CHECK constraint backstops it. A concurrent repair transition's `DEFECTIVE` condition
  can be clobbered by an in-flight edit, and the audit note records changed field _names_, not
  values, so the lost value is unreconstructable. AM-03 adds assignment writes on this same pattern
  with **no CHECK backstop** — decide there whether assignment needs `lockAsset` (closes the
  millisecond window, ~2 lines) or a version/`updatedAt` check (closes the stale-form window too).

**Into the retro / LEARNINGS §Testing:**

- **A CHECK constraint proven red for NULL is not proven red for empty string.** The DB-layer bypass
  test exercised `tag IS NULL` only and read as proof of the whole invariant, while `tag = ''` and
  `'   '` sailed through — structurally the same trap as AM-01's race test passing with the lock
  deleted. A falsifiability proof covers the case you wrote, not the invariant you meant.
- **`skipIf`-gated suites can pass without the env var.** Vitest autoloads `.env`, which defines
  `TEST_DATABASE_URL`, so the guard never engages locally and local test safety rests on the value
  in an individual developer's `.env` rather than on the caller's explicit override. CI is genuine
  (it sets the variable and has no `.env`).
