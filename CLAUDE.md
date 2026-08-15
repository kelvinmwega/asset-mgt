# CLAUDE.md — asset-mgt

Self-hosted IT asset register (replaced a legacy SaaS register). Design: `docs/DESIGN.md` ·
ADR: `docs/adr/ADR-001-vercel-neon-stack.md` · Stories: `docs/intake/asset-mgt/PRD.md`.

## Non-negotiables

- **Rendering mode: dynamic SSR.** Next.js 15 App Router, `force-dynamic` at the
  root layout. NEVER `output: 'export'`; the later PWA (AM-06) is a manifest +
  service worker over the dynamic app.
- **Deploy target:** Vercel serverless functions pinned to `fra1`
  (`vercel.json`) + Neon Postgres `eu-central-1` via the **pooled** connection
  string. No Terraform — `vercel.json`, `.env.example`, and the runbooks in
  `docs/RUNBOOK.md` are the configuration artefacts. (The runbooks lived in
  the README until the repo went public, 2026-08-15 — the README is now a
  simple public-facing page and must stay that way.)
- **Env chokepoint:** `src/lib/env.ts` (`env()`). No `process.env` reads at
  module top level anywhere — `pnpm build` must succeed with zero env
  populated (CI proves this every run). Optional Vercel platform metadata may
  be read inline with a null fallback.
  **The edge runtime does not share this chokepoint, and this is a second
  carve-out, not an instance of the first.** The metadata carve-out above
  covers _optional_ platform values with a null fallback; `AUTH_SECRET` is
  _required_ config with no safe fallback, so the rule is amended rather than
  stretched. `env()` imports `server-only` — and zod-parses the whole of
  `process.env`, demanding `DATABASE_URL` and `AUTH_RESEND_KEY` the edge has
  no business requiring — so `src/middleware.ts` cannot use it.
  `src/middleware.ts`'s `AUTH_SECRET` is therefore **the single permitted
  inline read of required config in the codebase**, and it must be a literal
  static `process.env.AUTH_SECRET` (no destructuring, no computed key, no
  spreading `process.env`: only statically analysable references survive into
  an edge bundle), read at request time, with no fallback and a loud throw
  when absent. That asymmetry is the trap: middleware is the one file where
  "go through `env()`" is the wrong answer.
  Both auth entrypoints must use the lazy `NextAuth(() => …)` factory form.
  The object form calls `setEnvDefaults` immediately, doing
  `config.secret ??= process.env.AUTH_SECRET` at module scope — read once per
  edge isolate at module evaluation, with the result (`undefined` included)
  cached on the shared `authConfig` object for that isolate's life. The
  callback defers it to request time, which is also what keeps the env-free
  build passing. A secret that fails to reach middleware produces no session
  at all and bounces every user to /signin, which looks exactly like broken
  sign-in (issue #14).
- **Authorisation:** `await requireRole(...)` (`src/lib/authz.ts`) is the FIRST
  statement of every mutating server action and route handler. Middleware
  (`src/middleware.ts`, edge-safe `src/auth.config.ts`, deny-by-default
  matcher) only authenticates; roles are always read from the DB, never from
  the JWT. Sessions are JWT. No open signup — users are provisioned, never
  self-registered.
- **`AssetEvent` and `UserEvent` are append-only.** Never write an update or
  delete against either, in code or SQL. Corrections are new events, and the
  audit insert happens in the same transaction as the mutation it records
  (`src/lib/user-admin.ts`, `src/lib/asset-admin.ts`). User deactivation is a
  flag (`deactivatedAt`), never a delete.
- **`Assignment` is a state row, not an audit row** — the one bounded
  exception to the rule above. Exactly two columns are mutable,
  `returnedAt` and `conditionNotes`, set exactly once, by the return
  path, on a row where `returnedAt IS NULL`. Every other column is
  write-once at insert; `Assignment` rows are never deleted. The audit
  anchor is the `ASSIGNED`/`RETURNED` `AssetEvent` pair. Enforcement is
  application-level, not a constraint: the update is predicated on
  `returnedAt IS NULL` with a `count === 1` assertion
  (`src/lib/asset-admin.ts`). `AssetEvent` and `UserEvent` remain
  append-only and this exception does not extend to them.
- **No personal data in event tables.** The application never writes a
  name, email or employee ref into `AssetEvent.notes` or any `UserEvent`
  field, and no new code may. The person link is
  `AssetEvent.assignmentId` → `Assignment.personId` — exactly one copy,
  joinable. Those tables are never updated and never deleted, so a name
  change or a DPA erasure request against a copied-in name is
  unhonourable by construction.
  **What the code cannot enforce:** `notes` is operator-typed free text,
  rendered to all four roles including `STAFF_RO` — who are otherwise
  shown no person data at all. Every form writing it carries a "never
  personal data" hint (`EventNoteHint`); that is guidance, not a
  guarantee, and it is the one place §`STAFF_RO`-sees-no-person-data can
  be bypassed. **Any feature that indexes or searches `AssetEvent.notes`
  must exclude it from `STAFF_RO` reach, or close this first** (AM-07).
  **AM-07 settled it by leaving `notes` unsearchable, and it stays that
  way.** The register's `?q=` (`src/lib/asset-search.ts`) traverses tag,
  serial, make, model and category name only, and the enforcement is
  behavioural rather than a grep: a real-DB test in
  `src/app/(app)/assets/page.integration.test.tsx` seeds a nonce into a
  note and asserts a search for it returns zero assets for **every** role
  including `ADMIN_IT`. A grep-guard passes the moment someone reaches
  `notes` through a relation filter spelled differently; that test does
  not. Same story reached `?q=` for holder names — it does not search
  them for any role, and no such predicate may be added to `/assets`
  without a new advisor ruling.
- **Nothing in this codebase is ever deleted.** `RETIRED` is an asset's delete
  (`db.asset.delete()` appears nowhere and must not); `deactivatedAt` is a
  user's; categories and sites are renamed, never removed. A delete would
  sever the audit trail that is the whole point of the register.
- **Asset status transitions go through `src/lib/asset-lifecycle.ts`** — the
  transition map is the single source of truth and status is not editable via
  the plain update path. `transitionAssetStatus` locks the asset row
  (`SELECT … FOR UPDATE`) before reading the current status: without it two
  concurrent transitions both pass the guard and the history records a
  transition that never happened.
- **Exactly one `AssetEvent` per action, never two.** The type is
  `ASSIGNED` when the action opens an assignment, `RETURNED` when it
  closes one, `STATUS_CHANGED` otherwise — so retiring an assigned
  asset writes a single `RETURNED` event carrying
  `fromStatus=ASSIGNED, toStatus=RETIRED`. **Status questions are
  answered by querying `fromStatus`/`toStatus`, never by event type.**
- **A tag is mandatory from delivery onwards**, enforced by the
  `Asset_tag_required_when_tracked` CHECK constraint (hand-written in the
  `am02_asset_lifecycle` migration — Prisma has no CHECK primitive, so preserve
  the block if that migration is ever regenerated). `ON_ORDER` and `RETIRED`
  are exempt: not yet delivered, and dead-on-arrival kit that goes back to the
  supplier untagged. Application guards exist for the error message; the
  constraint is the enforcement.
- **Emails are lowercased at every write and lookup** (sign-in policy, admin
  actions, seed). A case mismatch silently locks staff out.
- **`Person.email` is optional, and no synthesized address is ever written.**
  A holder is not necessarily a system user — login identity is `User.email`,
  which stays required and unique. The legacy export (AM-04) has no email
  column, so imported holders are created with `email: null`. A placeholder or
  `@…invalid` address is forbidden: it fabricates a personal datum, and two
  same-named people either collide on a confusing P2002 or **merge into one
  person**. A blank email must land as `NULL`, never `''` — Postgres permits
  many NULLs in a unique index but exactly one `''`, the same trap as
  `Asset.tag`. The cost of this is that `@unique` no longer dedupes imported
  people, which is why assignee matching is exact-unique-or-nothing with human
  sign-off and why import runs take a session advisory lock.
- **Exactly one `IMPORTED` event per imported asset** (`src/lib/asset-import.ts`).
  The import is a deliberately separate write path because every shortcut into
  `asset-admin.ts` fabricates history: `createAssetWithEvent` cannot express a
  legacy `ASSIGNED` row at all, create-then-transition writes `STATUS_CHANGED`
  events for transitions that never happened, and `assignAsset` would date a
  two-year-old handover to today. Assignments are inserted through
  `createOpenAssignmentTx` with the source `checkedOutAt`. Tests assert an
  EXACT event count, never a floor — a floor passes for the very shape this
  avoids.
- **The import is a CLI, and there is no upload endpoint** (`pnpm db:import`).
  `--commit` holds a session-scoped advisory lock across ~400 per-row
  transactions, so it needs an **unpooled** connection and does not fit a
  Vercel function — but see the next bullet: **unpooled is necessary and not
  sufficient.** Its events carry `actorId: null`, the same "system action"
  convention as the seed scripts. **No spreadsheet-parser dependency beyond
  `fflate`**, and no general XML parser — the reader hand-scans exactly four
  zip entries (billion-laughs/XXE). npm's `xlsx` is stale at 0.18.5 with fixes
  shipped only to SheetJS's own CDN; `exceljs` evaluates formulas and images
  we never read.
- **An unpooled URL does NOT make a session advisory lock safe — the client
  holding it must also be pinned to one connection** (AM-10). `pg_advisory_lock`
  is owned by the _backend_ that took it, and **Prisma keeps its own client-side
  pool even against a direct, non-PgBouncer URL**, so the lock and its
  `pg_advisory_unlock` can land on different backends. The unlock then returns
  `false` — **silently; it is not an error** — and the lock survives. Measured
  here: `lockPid=15133 unlockPid=15136 released=false` on a default pool, clean
  at `connection_limit=1`. `withImportLock`'s `try/finally` is correct and
  cannot help; the statement runs, it just runs in the wrong session.
  **The failure is a DEADLOCK, not a lost mutex.** The lock is over-held, so the
  next acquire in the same process blocks forever — which is why a CLI that does
  one run and exits hides it entirely, and why it surfaced only in the
  integration suite (many runs, one process) as an intermittent 20s test timeout
  followed by a 10s `$disconnect()` hook timeout, on CI and never locally.
  The test clients are pinned (`test/session-lock-client.ts`) and guarded by a
  `pg_locks` assertion — **cluster-wide on purpose**, because a
  `pg_backend_pid()` equality check passes by luck whenever the pool hands back
  the same connection. **`scripts/import-assets.ts` is NOT yet pinned**: not a
  live outage, since one run per process plus exit releases the lock, but the
  mutual exclusion it advertises is weaker than it claims, and a second
  `withImportLock` in one process would hang. Fix, cost (`connection_limit=1`
  means a concurrent query inside the locked section fails `P2024` after
  `pool_timeout`) and rationale: `docs/features/AM-10/DESIGN.md` §8.
- **`ImportBatch` is a bounded state row carrying no personal data.** Written
  once at run start, updated exactly once at run end, never deleted — the same
  bounded exception `Assignment` carries. `report` holds no name, email,
  employeeRef, or verbatim row echo; rows are identified by source row number
  plus tag, people by `personId`. The export's `Created by` column is **not
  imported anywhere** — parking it here would be a code-written copy of staff
  names in a table with no role gate and a blanket no-delete rule, strictly
  worse than the operator-typed `AssetEvent.notes` risk it appears to dodge.
  Names reach only the in-flight sign-off report an operator reads.
- **Real client exports never enter the repo.** `.gitignore` blocks
  `*.xlsx`/`*.xls`/`*.csv` repo-wide with `!*.example.csv`, **by extension and
  not by directory** — the first version of the rule was `docs/*.xlsx`, which
  git anchors to that directory, leaving `docs/features/AM-04/` uncovered.
  Fixtures are synthetic and must reproduce the real file's awkward shapes
  (sparse cells, money as a shared string, dates as bare serials) or they prove
  nothing. Note the PII is not only in the cells: `docProps/core.xml` carries
  `lastModifiedBy` and `xl/workbook.xml` an `absPath` with the exporter's
  Windows username, so the parser reads neither.
- **Sign-in throttle lives in `src/lib/sign-in-policy.ts`**, counting
  `VerificationToken.createdAt` rows (3/email/15 min; global 30/hour and
  ~80/rolling 24h), called from the `signIn` callback in `src/auth.ts`. Every sign-in rejection is an
  indistinguishable `false` — /signin renders one uniform message for all
  outcomes; never add distinct error surfaces to that flow.
- **`Person.employeeRef`, never a national ID** — no national-ID column may be
  added anywhere (brief §7.3, Kenya DPA note in `docs/DPA-TRANSFER-NOTE.md`).
- **`STAFF_RO` sees no person data.** No current holder and no holder
  history anywhere in the app, except that user's own
  `/me/assignments` — the data is **not fetched** for that viewer, not
  merely unrendered, so a later UI change cannot leak it. Person field
  visibility lives in exactly one place, `personSelectFor(role)` in
  `src/lib/person-visibility.ts`, which is the only place in the
  codebase a `Person` select **carrying PII** may be written — that
  module's docblock names the two benign exceptions and gives the exact
  grep to audit with. Widening it requires a DPA note review
  (`docs/DPA-TRANSFER-NOTE.md`).
- **Real-DB tests:** integration tests run against real Postgres via
  `describe.skipIf(!process.env.TEST_DATABASE_URL)` (see
  `src/lib/db.integration.test.ts`); local Docker Postgres 17 / CI service
  container. Mocks cannot guard read/write seams.
- **Prisma:** client comes from `getDb()` in `src/lib/db.ts` — lazy-init
  `globalThis` singleton, plain instance, never a JS Proxy wrapper. Prisma is
  pinned to major 6.
- **Versions:** pnpm (pinned via `packageManager`), Node 22 (`.nvmrc` +
  `engines`), Postgres major 17 (compose + CI + backup — keep in sync with the
  Neon project).

## Process

- Conventional commits. CI (`ci` check: lint, typecheck, tests incl. real-DB,
  env-free build) is the required check on `main`.
- Security-touching work (auth, PII, deletion) floors at Tier 3 — advisor
  review before merge. First story: AM-01.
- **What satisfies the T3 gate.** A ruling from the `advisor` agent obtained
  before merge, with every condition it names either met or explicitly
  overruled **in the PR body, one by one, in writing**. The gate is not "an
  advisor was consulted" — an unanswered condition is an unmet gate. Ask for a
  ruling with conditions in that shape and the review is checkable by anyone.
- **Red-prove every guard a condition names**, by deleting the production line
  that defends it and watching the test fail. A ruling does not make its own
  conditions true: on #14 the advisor's "no fallback, ever" condition was
  implemented and guarded, and `?? "dev-secret"` still passed the whole file —
  throw unreachable, sessions signed with a known value. Guards written to
  satisfy a ruling fail the same way as any other (see #12).
- **If the advisor is genuinely unavailable**, the floor is satisfied instead
  by all three of: the guards enumerated in the design doc _before_
  implementation, Kelvin's recorded decision naming that specific list, and
  each guard proven red. "No advisor available, so we skipped it" is not a
  resolution — it is the thing this clause exists to prevent. Precedent and
  worked example: `docs/features/AM-09/DESIGN.md` §7.
- The advisor was non-responsive throughout AM-09 (2026-08-02), which is what
  prompted the clause above. It was re-tested on 2026-08-02 and is **working**:
  a full three-question T3 consult returned in ~9 minutes and a trivial probe
  in ~4 seconds, with and without an explicit model override. The
  invalid-`model:`-fails-silently theory recorded in the studio LEARNINGS
  §Tooling is **ruled out for this agent** — its frontmatter is valid. Root
  cause of the AM-09 failure remains unknown and unreproduced, so if it
  recurs, fall back rather than spending the session diagnosing it.
