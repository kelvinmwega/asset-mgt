# Operational runbooks

There is deliberately no Terraform ([ADR-001](adr/ADR-001-vercel-neon-stack.md)).
This document plus `vercel.json` and `.env.example` are the configuration
record — keep all three current when anything here changes.

## Seeding details

`pnpm db:seed` loads `.env` (so it targets whatever `DATABASE_URL` points at)
and explicit env vars override it — always pass a local `DATABASE_URL` when
seeding the Docker database if your `.env` holds the production string. It
refuses to run without `SEED_ADMIN_EMAIL`, creates-or-promotes that user to
`ADMIN_IT`, never downgrades an existing role, and is idempotent. A real
staff CSV is personal data: keep it in `seed-data/` (gitignored) — only the
synthetic `scripts/staff.example.csv` may be committed.

`pnpm db:seed:reference` loads the same way and seeds the asset categories and
sites. It reads `type,name` rows from `REFERENCE_CSV`, defaulting to the
generic `scripts/reference.example.csv`; real site names belong in
`seed-data/`, not the repo. It is idempotent (re-running duplicates and renames
nothing), fails on an unknown `type` naming the offending row rather than
skipping it, and exits non-zero if the run would finish with zero categories —
an asset cannot be created without one. Admins can add and rename categories
and sites afterwards at `/admin/reference` without a deploy.

## Mutation testing

`pnpm test:mutation` runs Stryker over the five modules that encode an
invariant a test claims to defend — the lifecycle transition map, the person
-data chokepoint, the assignment/return write path, the sign-in throttle, and
the confirm dialog. It answers the question this project has got wrong six
times: _if I delete the production line this test defends, does the test go
red?_ Configuration, the triage of every surviving mutant, and how the
breaking threshold was chosen are all in `stryker.config.mjs`.

It is **not** part of the `ci` required check — most mutants cost a Postgres
round-trip, so a full run is ~10 minutes locally (9m50s over 382 mutants at the
2026-08-02 triage). It runs weekly and on pull requests that touch a mutated
module or its tests (`.github/workflows/mutation.yml`), and it can fail the
build.

**It requires `TEST_DATABASE_URL`, and refuses to start without it.** Three of
the five modules are covered only by real-DB integration tests, which _skip_
rather than fail when that variable is missing — so a run without it would
report a score computed from tests that never ran.

## Provisioning runbook (manual — substitutes for IaC state)

1. **Vercel project** — import `kelvinmwega/asset-mgt` into the Vercel team
   (Hobby; ToS risk accepted, ADR-001). Framework preset: Next.js. Production
   branch: `main` (previews per PR are automatic). Function region `fra1` is
   pinned by `vercel.json`.
2. **Neon Postgres** — `vercel integration add neon`, region **eu-central-1**
   (colocated with `fra1`). Use the **pooled** connection string as
   `DATABASE_URL`. Verify the Neon project's Postgres major and keep
   `docker-compose.yml`, `.github/workflows/ci.yml`, and
   `.github/workflows/backup.yml` pinned to the same major (currently 17).
3. **Resend** — create the API key (`AUTH_RESEND_KEY`) and **verify a sending
   domain**: the free-tier default sender (`onboarding@resend.dev`) only
   delivers to the Resend account owner, so magic links will NOT reach staff
   until a verified domain backs `AUTH_EMAIL_FROM`.
4. **Vercel env vars** (**Production only** as actually provisioned — see the
   note below): `DATABASE_URL`, `AUTH_SECRET` (`openssl rand -base64 32`),
   `AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM`. Plus, at
   **Production scope only**, `MIGRATE_DATABASE_URL` — the **unpooled**
   connection string, marked sensitive, used by the build-time migration gate
   ([ADR-002](adr/ADR-002-build-gated-migrations.md)). Its absence from
   Preview is the primary guard stopping a preview build from migrating
   production, so **never widen its scope**; the `VERCEL_ENV` check in
   `scripts/migrate-if-production.sh` is only defence in depth. All except
   `MIGRATE_DATABASE_URL` are enumerated with placeholders in
   [.env.example](../.env.example)
   ([#33](https://github.com/kelvinmwega/asset-mgt/issues/33) adds it) — real
   secrets live only in Vercel env vars and gitignored `.env`.

   This line said "(Production + Preview)" until 2026-08-07, describing an
   intent that was never applied — `vercel env ls` shows all four scoped
   **Production only**. Two consequences, and the second is the one people trip
   over: there is no shared signing key, so a preview-minted session does **not**
   validate on production; and **preview deployments are non-functional**, since
   the app requires all four through `src/lib/env.ts` and a preview has none of
   them. Give preview its own values if you want working previews — a
   **different** `AUTH_SECRET`, and ideally a Neon branch rather than the
   production database.

   The Neon integration's `STORAGE_*` variables _are_ scoped Production +
   Preview and do point at the production database. Nothing in this codebase
   reads them, but they are present in every preview build container
   ([#27](https://github.com/kelvinmwega/asset-mgt/issues/27)).

5. **Migrations** — run `pnpm db:deploy` against the Neon `DATABASE_URL` at
   provisioning. Thereafter the deploy pipeline owns it: a production build
   applies pending migrations before it builds (ADR-002). That requires a
   `MIGRATE_DATABASE_URL` environment variable in Vercel — the **unpooled**
   connection string, **Production scope only**, sensitive. Its absence from
   Preview is the primary guard stopping a preview build from migrating
   production, so never widen its scope. See
   §[Recovering a failed migration](#recovering-a-failed-migration).
6. **Deploy and seed** — push to `main`. Then provision users against Neon:
   `DATABASE_URL=<neon-pooled-url> SEED_ADMIN_EMAIL=<admin-mailbox> STAFF_CSV=seed-data/staff.csv pnpm db:seed`
   (the admin mailbox must be a real mailbox with MFA — AM-01 design), then
   the reference data the register needs:
   `DATABASE_URL=<neon-pooled-url> REFERENCE_CSV=seed-data/reference.csv pnpm db:seed:reference`
   (omit `REFERENCE_CSV` to seed the generic defaults; the run exits non-zero
   rather than leaving zero categories, since an asset cannot be created
   without one). Sign in at `/signin` with the admin email via magic link
   (needs the verified Resend domain from step 3), then verify `/health`
   returns JSON while authenticated and confirm `/admin/users` lists the
   seeded staff and `/admin/reference` lists the categories.
   Unauthenticated requests redirect to `/signin` — that is the
   deny-by-default gate working.
7. **Nightly backups — REQUIRED before AM-04 cutover sign-off** (advisor
   condition): set the `DATABASE_URL` repo secret in GitHub
   (Settings → Secrets → Actions) to the Neon connection string, then run the
   **Nightly DB backup** workflow manually and verify a green run with a
   non-empty dump artifact. Until the secret exists the workflow no-ops with
   a warning. Neon's free-tier restore window is short; after the old
   register is cancelled these dumps are the independent copy.
8. **Kenya DPA** — staff PII is processed in the EU; see
   [DPA-TRANSFER-NOTE.md](DPA-TRANSFER-NOTE.md). ODPC data-controller
   registration is the operating organisation's obligation via its own
   counsel.

## Runbook — legacy register cutover (AM-04)

The migration import. **Read this before running it against production**: it
creates `Person` records and permanent reference rows, and nothing in this
codebase is ever deleted.

### Before you start

1. **The backup must have been RESTORED, not just taken.** ADR-001's nightly
   `pg_dump` has to have been restored once into a throwaway Neon branch and
   checked, and the result recorded, before any production `--commit`. An
   untested backup is a belief, and this register becomes the only system of
   record the moment the old register is cancelled.
2. **Get the export out of the repo.** Real exports carry staff names, serials,
   PO numbers and cost centres. `.gitignore` blocks `*.xlsx`/`*.xls`/`*.csv`
   repo-wide, but keep the file outside the working tree anyway, and delete it
   from the machine when the cutover is signed off. The exporting system's own
   copy is the retained original.
3. **Use the unpooled connection.** `--commit` holds a session-scoped advisory
   lock across every row's transaction; on a pooled connection that lock may be
   released onto a different backend, which silently removes the only thing
   stopping two concurrent runs from each creating their own copy of one
   person. Set `DIRECT_DATABASE_URL`.

### 1. Dry run

```bash
DIRECT_DATABASE_URL='postgresql://…' pnpm db:import ~/cutover/export.xlsx
```

Writes nothing. It performs every read and write and rolls each row back, so
what it reports is what the database will actually accept — not a guess.

It prints:

- **counts** — imported / skipped / conflicts / quarantined, which must add up
  to the source row count;
- **quarantined rows** with a reason and the **row numbers to look up in your
  own spreadsheet**;
- **SIGN-OFF 1 — reference rows** it would create;
- **SIGN-OFF 2 — assignee resolution**, each person listed once as `MATCHED`,
  `WILL CREATE` or `AMBIGUOUS`;
- the batch id, and both hashes.

### 2. Sign off — the two one-way doors

These are the reason the import is two commands, and neither is recoverable by
re-running:

- **Reference rows are renamed, never removed, and a rename cannot merge.** A
  typo signed off here is permanent. Check that "DOCKING STATION" is not about
  to join an existing "Docking Station" as a second category.
- **A wrong holder cannot be undone.** `Assignment` is write-once and
  `AssetEvent` is append-only, so the only available correction is a fabricated
  return. Anything listed `AMBIGUOUS` was quarantined rather than guessed —
  resolve those people by hand first, then re-run the dry run.

Attach the printed report to the cutover checklist. It is the sign-off record.

### 3. Commit

```bash
DIRECT_DATABASE_URL='postgresql://…' \
  pnpm db:import ~/cutover/export.xlsx --commit --batch=<id from step 1>
```

`--commit` re-parses the file and recomputes both the source SHA-256 and the
normalised row hash. **If the file changed at all since the dry run, it
refuses** — so what is committed is provably what was signed off. Edited the
spreadsheet to fix quarantined rows? That is a new dry run and a new sign-off.

### 4. Reconcile

Re-running the import is safe and is the intended way to finish a partial run:
it is **insert-only**, so an existing tag is skipped and never updated. A row
whose other fields changed is reported as a `CONFLICT` and still not written —
which is deliberate, so a re-run cannot revert edits an admin made in the app
between runs.

Then run the data-integrity queries below, and check the register's own totals
against the old register's before cancelling its subscription.

## Runbook — data integrity

`Asset.status = 'ASSIGNED'` and the existence of an open `Assignment` row
(`returnedAt IS NULL`) are two halves of one invariant, maintained
transactionally in `src/lib/asset-admin.ts`. It **cannot** be enforced in SQL —
a CHECK constraint cannot reference another table — so direct SQL, or a future
write path that bypasses that module, can desynchronise them. Detection is by
reconciliation query; both halves must return zero rows.

```sql
-- Assets marked ASSIGNED with no open assignment
SELECT a."id", a."tag" FROM "Asset" a
WHERE a."status" = 'ASSIGNED'
  AND NOT EXISTS (SELECT 1 FROM "Assignment" x
                  WHERE x."assetId" = a."id" AND x."returnedAt" IS NULL);

-- Open assignments whose asset is not ASSIGNED
SELECT x."id", x."assetId" FROM "Assignment" x
JOIN "Asset" a ON a."id" = x."assetId"
WHERE x."returnedAt" IS NULL AND a."status" <> 'ASSIGNED';
```

When the two disagree, **the open `Assignment` row is the source of truth for
holdership** — `Asset.status = 'ASSIGNED'` is a transactionally-maintained
projection of it. Reconcile by bringing the asset's status back into line, never
by closing an assignment that was not actually returned: that would fabricate a
return in the audit trail.

Concretely, per row the queries return:

- **First query** (asset says `ASSIGNED`, nobody holds it): the asset is not
  actually held. Set its status to what it really is — normally `IN_STOCK`.
- **Second query** (someone holds it, asset does not say `ASSIGNED`): **no
  application path can fix this one.** The return path only closes an assignment
  when the asset's current status is `ASSIGNED`, and `returnAsset` is rejected by
  the lifecycle guard from any other status — so the app cannot close the
  assignment and cannot be made to. Repair it in two steps: set the status back
  to `ASSIGNED`, then perform a normal return through the app so the closure is
  recorded with its `RETURNED` event and condition. Do **not** close the
  assignment with raw SQL; that severs the audit trail the register exists for.

Run it — and every other `psql` or Prisma command in this repo — against an
**explicitly named database**. The gitignored `.env` holds the **production**
`DATABASE_URL` and the Prisma CLI autoloads it, so a bare `pnpm db:migrate` or
`prisma studio` can silently hit production ([AM-01 retro](retros/am-01.md),
item 5); `psql` has no such default, so pass the connection string every time:

```sh
psql "$TARGET_DATABASE_URL" -f reconcile.sql   # never a bare psql / prisma
```

## Recovering a failed migration

> **This runbook is WRITTEN BUT UNPROVEN.** Issue #31 is the condition that
> executes it against a Neon branch and corrects whatever turns out to be wrong.
> Until that closes, treat every command here as a first draft and read Prisma's
> output before acting on it.

Under ADR-002 a production build applies migrations before it builds. A failure
therefore **blocks every production deploy, hotfixes included** — Prisma P3009:
_"Until you recover from the failed state, further migrations using
`prisma migrate deploy` are impossible."_ Recovery needs the direct production
credential and a human.

Set the target once (unpooled — the pooler breaks Prisma's session advisory
lock), and never run a bare `prisma` command, because the CLI autoloads `.env`:

```sh
DIRECT="<the MIGRATE_DATABASE_URL value>"
DATABASE_URL="$DIRECT" pnpm exec prisma migrate status
```

There are **three** distinct frozen states and they are not interchangeable.

**1. Failed and rolled back.** The migration errored and Postgres undid it. The
database matches the previous migration. Mark it rolled back, fix the migration
file, redeploy:

```sh
DATABASE_URL="$DIRECT" pnpm exec prisma migrate resolve --rolled-back <migration_name>
```

**2. Failed and partially applied.** Prisma does **not** guarantee a migration
file runs in a single transaction — the docs describe migrations that "can only
be partially executed". **Inspect the schema before choosing.** If some
statements landed, decide whether to finish them by hand and mark it applied, or
undo them by hand and mark it rolled back:

```sh
# only after confirming, by inspection, that the schema now matches the file
DATABASE_URL="$DIRECT" pnpm exec prisma migrate resolve --applied <migration_name>
```

Choosing wrong here is not recoverable by re-running anything — this register's
entire value is its audit trail, so prefer inspecting for an hour over guessing.

**3. Applied but checksum-drifted.** Editing an already-applied migration file
changes its SHA-256 and `migrate deploy` refuses to proceed. **This repo has two
hand-edited migrations** (`am02_asset_lifecycle` carries the
`Asset_tag_required_when_tracked` CHECK; `am03_assignment` carries the partial
unique index) with "PRESERVE if regenerated" banners. Before ADR-002 a stray
`prisma migrate dev` regeneration cost a local annoyance; now it freezes
production deploys. **Fix: restore the file's original content from git** —
`git log -p -- prisma/migrations/<name>/migration.sql` — rather than resolving
anything, because the database is correct and the file is not.

**While frozen, reverting the migration-bearing commit does NOT unblock
deploys** — and reaching for it first is the natural mistake. P3009 is raised
from the _database_, not the migrations folder: `migrate deploy` pre-flights
`_prisma_migrations` for rows with `finished_at IS NULL AND rolled_back_at IS
NULL` before it computes anything pending, so deleting the migration directory
leaves the failed row, the check, and the red build exactly where they were.
Under incident pressure that costs a revert PR, a review and another failed
build before anyone notices it changed nothing.

**Follow the matching state above first** — 1 and 2 are resolved with
`migrate resolve`, 3 by restoring the file from git, and they are not
interchangeable. Only then is reverting the migration-bearing commit optional,
and only to stop the migration re-applying: the schema change itself stays,
because `migrate deploy` is forward-only and never un-applies anything.
