# PRD — Internal IT Asset Register (`asset-mgt`)

- **Date:** 2026-07-24
- **Effort band:** M (see `SOLUTION.md`)
- **Milestone 1 deadline:** before the legacy register's new pricing model applies (exact date pending — brief §7.2)

Stories in priority order. Tiers per studio ship process (T0 trivial → T3 security/high-rigour). "Real DB" means acceptance tests run against a real Postgres instance, not mocks.

---

## Milestone 1 — Cutover (the path to cancelling the legacy register)

### AM-01 — Authentication and roles — **T3**

_As the IT admin, I can give each colleague exactly the access their job needs, so that procurement, finance, and staff can use one tool without seeing or changing what they shouldn't._

**Acceptance criteria**

- Four roles: `ADMIN_IT`, `PROCUREMENT`, `FINANCE`, `STAFF_RO`. Staff are read-only, enforced server-side on every mutating route (real DB).
- Unauthenticated users can access nothing.
- Role assignment is changeable at runtime by `ADMIN_IT` (no redeploy).
- Person records store an employee reference — **not** a national ID — unless the client provides explicit justification (brief §7.3).
- **Advisor security review completed before merge** (security floor, studio rule).

**Dependencies:** project scaffold. **Blocks:** everything.

### AM-02 — Asset register and lifecycle — **T2**

_As a procurement or IT user, I can record any IT asset from order through delivery, tagging, repair, and retirement, so the register reflects reality at every stage._

**Acceptance criteria**

- CRUD with role gates (procurement + IT write; finance read; staff read).
- Tag is the client's own numeric scheme: unique at the database level, nullable until delivery; a "tag on delivery" flow moves `ON_ORDER → IN_STOCK` and requires a tag.
- Status lifecycle per `SOLUTION.md`; illegal transitions rejected (real DB).
- Every create/update/transition appends to the immutable `AssetEvent` history.
- Categories cover any IT asset; site recorded per asset; purchase data (date, price, supplier, warranty) captured.

**Dependencies:** AM-01.

### AM-03 — Assignment and returns — **T2**

_As the IT admin, I can assign an asset to a member of staff and take it back with a condition note, so "who has what, and in what state" is always answerable._

**Acceptance criteria**

- An asset cannot be assigned to two people at once (database constraint, real DB).
- Return captures a condition note; repair-bound returns transition to `IN_REPAIR`.
- Per-asset history (every holder, every repair) and per-person view ("everything X currently holds").
- A staff user can see their own assignments; nobody else's details beyond name.

**Dependencies:** AM-02.

### AM-04 — Legacy register migration import — **T2**

_As the IT admin, I can import our legacy register backup and verify nothing was lost, so we can cancel the subscription before the new pricing applies with confidence._

**Acceptance criteria**

- Dry-run mode produces a row-level report (imported / skipped / failed with reason) before anything is written.
- Idempotent: re-running an import does not duplicate assets (real DB).
- All ~400 assets land with tag, category, status, purchase data, and current assignee mapped; unmapped rows are reported, never silently dropped.
- Reconciliation summary matches the legacy register's totals; client signs off the cutover checklist.
- Week-1 task feeding this story: inspect the client's actual export file and lock the field mapping.

**Dependencies:** AM-02 (assets), AM-03 (assignee mapping).

> **Milestone 1 exit:** client cancels the legacy register. Success metric 1 of the brief.

---

## Milestone 2 — Round-out

### AM-05 — Reports and finance export — **T2**

_As the finance user, I can pull a purchase/value report shaped for our finance system, so asset data reaches finance without retyping._

**Acceptance criteria**

- Register export to CSV, filterable by site, status, category, and date range.
- A finance-shaped export whose columns are agreed with the finance user (week 1) and versioned — the export contract from `SOLUTION.md`.
- Exports respect roles (finance and IT admin only).

**Dependencies:** AM-02, AM-03.

### AM-06 — PWA and mobile flows — **T1**

_As a field worker, I can install the tool on my phone and look up, assign, or return an asset one-handed, so the register stays accurate away from a desk._

**Acceptance criteria**

- Installable (manifest + service worker) on Android and iOS.
- Lookup, assign, and return flows usable on a phone screen.
- Cached reads of recently viewed data when offline; no offline writes; a clear offline indicator.

**Dependencies:** AM-02, AM-03.

### AM-07 — Dashboard and search — **T1**

_As any user, I can search by tag, serial, or person and see the register's state at a glance, so answers take seconds, not queries._

**Acceptance criteria**

- Global search across tag, serial, model, and person name (role-filtered).
- Counts by status and site; lists of assets in repair and delivered-awaiting-tag.
- Loads usably on both desktop and phone.

**Dependencies:** AM-02, AM-03.

---

## Post-MVP backlog (unordered)

Direct Oracle integration (once the product is identified); depreciation; maintenance schedules; email alerts (warranty expiry, overdue returns); label printing for the tag scheme; asset photos/attachments; scheduled audit workflows.

---

**Handoff:** Discovery Brief ready at `docs/intake/asset-mgt/DISCOVERY-BRIEF.md`. First story: **AM-01** (suggested **T3**).
