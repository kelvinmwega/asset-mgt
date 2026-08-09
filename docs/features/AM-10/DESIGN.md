# Design: AM-10 — timestamps in the viewer's timezone

**Slug:** `AM-10`
**Tier:** T3 — deliberate reversal of a shipped audit-rendering decision
(AM-09 §4.3). The candidate data migration that also carried the tier has been
**dropped from scope** — see §6.
**Advisor consult:** 2026-08-09 — **concurs with what shipped on Q1, Q2 and Q3**,
with eight conditions (C1–C8), all met. See §5.
**Brief:** `docs/intake/asset-mgt/PRD.md` — no story; raised directly by Kelvin
**Date:** 2026-08-09
**Status:** Approved by Kelvin (rendering approach, zone label, fallback)

## 1. Problem

Every instant in the register renders in UTC. Staff are in Nairobi, UTC+3, so an
asset handed over at 09:00 reads `06:00 UTC` and every reader does the
arithmetic in their head. The history timeline — the surface the register exists
for — is the one hardest to read.

AM-09 chose this deliberately (`docs/features/AM-09/DESIGN.md` §4.3, and the
docblock on `exactTimestamp`): _"an audit trail that renders differently per
viewer is not one."_ That reasoning was sound and its cost has since been felt
in daily use. **This design reverses it, and the reversal is the whole point of
the tier.** What follows is the case that the audit property can be kept while
the arithmetic goes away.

The forcing function is Kelvin's brief: store everything in UTC, display in the
viewer's zone.

### What "stored in UTC" is worth today — verified, not assumed

Probed against the repo's own Postgres 17 container with migrations applied:

- All 21 instant columns are `timestamp(3) **without** time zone`.
- Such a column populated by its own `DEFAULT CURRENT_TIMESTAMP` **is**
  corruptible: with `SET TimeZone='Africa/Nairobi'` the value stored was
  `2026-08-10 00:30:29`, which Prisma reads back as an instant **three hours in
  the future**. A sibling `timestamptz` column was correct under the same GUC.
- **But Prisma never takes that path.** With query logging on,
  `db.person.create({ data: { name } })` emits
  `INSERT INTO "Person" ("id","name","createdAt","updatedAt") VALUES ($1,$2,$3,$4)`
  with params `[…,"2026-08-09 21:32:09.655 UTC","2026-08-09 21:32:09.655 UTC"]`.
  Prisma 6.19.3 supplies `@default(now())` client-side, UTC-labelled. The DDL
  defaults are dormant.
- No raw SQL in the codebase inserts into a timestamp column
  (`asset-admin.ts:144`, `user-admin.ts:36`, `asset-import.ts:184` are the only
  raw statements; they select, lock, and take an advisory lock).

So storage is already reliably UTC **through Prisma**, and the `timestamptz`
question is defence-in-depth over a dormant path — reachable only by a manual
psql fix-up against prod, or by a `$executeRaw` someone adds later. It is
deliberately framed that way rather than as a bug fix, because the honest
framing is what makes the proportionality question answerable.

### The hazard this work could introduce

`Asset.purchasedAt` and `Asset.warrantyUntil` are calendar dates pinned to UTC
midnight (`actions.ts:50-57`, `import-map.ts:221-229`). Probed with Node forced
to a non-UTC zone:

| written                                                   | stored as `date` | read back                      |
| --------------------------------------------------------- | ---------------- | ------------------------------ |
| `2026-06-21T00:00:00Z` (what the app writes)              | `2026-06-21`     | `2026-06-21T00:00:00.000Z`     |
| `2026-06-21T23:30:00Z` (stray time component)             | `2026-06-21`     | `2026-06-21T00:00:00.000Z`     |
| **`2026-06-21T00:00:00+03:00` (local midnight, Nairobi)** | **`2026-06-20`** | **`2026-06-20T00:00:00.000Z`** |
| `2026-06-21T00:00:00-04:00` (local midnight, New York)    | `2026-06-21`     | `2026-06-21T00:00:00.000Z`     |

A local-midnight `Date` from any UTC**+** zone lands a **day early**. Every user
of this system is UTC+3. This is the concrete way a timezone feature corrupts
data, it is silent, and it exists **independently of the column type** — today's
`timestamp` column would store `2026-06-20T21:00:00Z` and the UTC formatter
would render "20 Jun". Guarding it (G2) matters more than the storage question.

## 2. Constraints

- `AssetEvent` and `UserEvent` are append-only. No migration may rewrite their
  content; a type change that preserves every instant exactly is the only
  acceptable touch.
- The hand-written `Asset_tag_required_when_tracked` CHECK block in
  `am02_asset_lifecycle` must survive any migration regeneration (CLAUDE.md).
- Calendar dates must not shift by a day for any viewer, in either direction.
- `pnpm build` must keep succeeding with zero env populated.
- Rendering mode stays dynamic SSR; the viewer's zone is not knowable on the
  server without sending it there (see §4).
- `docs/DPA-TRANSFER-NOTE.md` carries a review trigger for data that becomes
  **displayed** rather than merely stored, and for new personal data crossing
  the wire.

## 3. Proposed design

### 3.1 Rendering (the substance of the change)

Three pieces, split so the formatting logic stays pure and testable and only the
zone _resolution_ is environment-dependent — the same split
`relativeTime(value, now)` already uses for the clock.

```
src/lib/relative-time.ts
  exactTimestamp(value, timeZone)   pure. zone in, string out. no ambient reads.

src/lib/use-viewer-time-zone.ts
  useViewerTimeZone(): string | undefined
    undefined during SSR and the first client render;
    the resolved IANA zone after mount.

src/components/timestamp.tsx        "use client"
  renders exactTimestamp(value, tz ?? "UTC")
  <time dateTime={value.toISOString()}> — always UTC ISO, both variants
```

`useViewerTimeZone` returns `string | undefined` and resolves in an effect
rather than in a `useState` initialiser. That is the documented shape in
LEARNINGS §Frontend — an initialiser that reads an environment probe captures
the SSR sentinel and never re-runs. It also means the first client render
matches the server byte-for-byte, so there is **no hydration mismatch and no
`suppressHydrationWarning`**; the swap to local time is an ordinary post-mount
re-render.

The consequence, stated plainly: the server render, the no-JS render, and the
first paint all show **UTC, labelled UTC**. Then it becomes local. That is the
price of not sending the viewer's zone to the server, and §4 argues it is the
right price.

### 3.2 The zone label — what it will actually say

Kelvin approved this option against a preview reading `21:21 EAT`. **`EAT` is
not what the obvious implementation produces** and that is corrected here rather
than quietly shipped. Measured across `Intl` options:

| option          | Nairobi            | UTC                          | London                | New York                | Kolkata               |
| --------------- | ------------------ | ---------------------------- | --------------------- | ----------------------- | --------------------- |
| `short` (en-GB) | `GMT+3`            | `UTC`                        | `BST`                 | `GMT-4`                 | `GMT+5:30`            |
| `short` (en-KE) | `EAT`              | —                            | —                     | —                       | —                     |
| `shortOffset`   | `GMT+3`            | `GMT+0`                      | `GMT+1`               | `GMT-4`                 | `GMT+5:30`            |
| `long`          | `East Africa Time` | `Coordinated Universal Time` | `British Summer Time` | `Eastern Daylight Time` | `India Standard Time` |

**Decided by Kelvin (2026-08-09): `short` under the app's existing `en-GB`
locale**, giving
`2026-08-01 21:21 GMT+3` and keeping `2026-08-01 21:21 UTC` verbatim for the
server render. It is unambiguous everywhere, needs no knowledge of zone
abbreviations to reconcile, keeps `UTC` as the canonical audit label, and
changes the existing string shape by exactly one token. `EAT` would require
pinning `en-KE` for this one formatter, and buys prettiness at the cost of an
abbreviation an auditor outside East Africa has to look up.

The date shape stays `YYYY-MM-DD HH:mm` rather than the `1 Aug 2026` form in
the option preview: sortable, scannable in table cells, and a smaller diff.
Both are one-line changes if Kelvin prefers otherwise.

### 3.3 What deliberately does not change

- **`relativeTime`** — elapsed-millisecond arithmetic, zone-independent. Its
  `yesterday` is already an elapsed-hours approximation and not a calendar-day
  computation, so no zone belongs in it.
- **`toDisplayDate` / `toDateInput`** (`assets/[id]/page.tsx`) — keep
  `timeZone: "UTC"`. Calendar dates are not instants.
- **`optionalDate`** (`assets/actions.ts:50-57`) — keeps its `T00:00:00Z` pin.
- **The `<time dateTime>` attribute** — UTC ISO-8601 in every variant. This is
  the audit anchor that makes per-viewer text safe.

### Data model changes

**None. Dropped from scope** (Kelvin, 2026-08-09) — the storage change existed
to be ruled on for proportionality, and with no ruling available the honest move
is not to make a 9-table migration against an append-only audit register on my
own judgement. It is deferred to its own story with its own consult (§8), and
loses nothing today: §1 establishes that storage is already reliably UTC through
Prisma. Recorded here so the analysis is not lost:

- 21 instant columns → `@db.Timestamptz(3)`, via
  `ALTER TABLE … ALTER COLUMN … TYPE timestamptz(3) USING "col" AT TIME ZONE 'UTC'`.
  The `USING` clause is load-bearing: without it Postgres reinterprets the naive
  value in the session zone, silently shifting every historical instant.
- `Asset.purchasedAt`, `Asset.warrantyUntil` → `@db.Date`. Verified safe:
  Prisma serialises the param as UTC-labelled regardless of process TZ, and the
  column round-trips the existing UTC-midnight convention exactly. This makes
  "a calendar date cannot carry a time" structural instead of conventional.

Both are data-preserving. Neither rewrites an audit row's content.

### Contract changes

None. No API, no event payload, no breaking change.

## 4. Options considered

| Option                                                 | Summary                                                                                                | Why not chosen                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed org timezone (`Africa/Nairobi`), server-rendered | Readable local times, identical for every viewer, no client component, no swap on load, no DPA surface | Rejected by Kelvin in favour of true per-viewer. Remains the fallback if the client-component cost proves unacceptable                              |
| Viewer's zone, no zone label                           | Cleanest text                                                                                          | A screenshot no longer says which clock it came from; two admins comparing screens cannot tell a timezone difference from a data difference         |
| Timezone **cookie**, so the server can format          | Kills the UTC-then-local swap entirely                                                                 | Sends a client-derived signal about the data subject across the wire, tripping the DPA note's review trigger, to buy a cosmetic improvement. See §5 |
| Per-user timezone column                               | Explicit, no probing                                                                                   | A schema change and a settings UI for something the browser already knows correctly                                                                 |

Contested choices become ADRs: **none contested**. The one genuinely contested
question — whether a 9-table migration is proportionate to a dormant risk — is
deferred rather than decided here (§6, §8).

## 5. Security review

- **Surface touched:** PII-adjacent. No auth, secrets, payment or deletion path
  is modified.
- **Threats considered.** (i) A viewer's IANA timezone is a weak location and
  fingerprinting signal about a data subject. Reading it via
  `Intl.DateTimeFormat().resolvedOptions().timeZone` collects and transmits
  **nothing** — it is computed and used in the browser and never leaves it. A
  timezone cookie would be a different act: a new client-derived signal about
  the person crossing the wire and landing in request logs. **Stated at the
  right strength (advisor C8): that would not be unlawful, it would buy a legal
  review this story has no need to buy.** Two engineering reasons kill the
  cookie independently of any of that — it does not remove the client component,
  because there is no cookie on the first request, and it makes the HTML vary by
  viewer zone, which AM-06's planned service worker would cache and replay
  across zones. `x-vercel-ip-timezone` is rejected on the same grounds plus a
  worse one: it infers the zone from network location, which is wrong for a VPN
  and wrong for a traveller. (ii) No new data is displayed — the same instants render, in a different zone,
  so the DPA note's "displayed rather than stored" trigger is examined and found
  not to fire. (iii) `STAFF_RO` person-data rules are untouched: timestamps are
  not person data and `personSelectFor` is not modified.
- **Tenant scoping:** not applicable — single-tenant register, no read or write
  path changes.
- **Secrets handling:** unchanged.
- **Advisor ruling (2026-08-09): concurs with what shipped on Q1, Q2 and Q3**,
  with eight conditions. All eight are met; each is answered individually in the
  PR body, which is what the T3 gate requires.

  | #   | Condition                                                        | Met by                                                                 |
  | --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
  | C1  | Zone label is `shortOffset`, not `short`                         | `relative-time.ts`; red-proven with `short` + `en-US` → `EDT`/`EST`    |
  | C2  | DST applied per instant                                          | New York renders `GMT-5` in January, `GMT-4` in July                   |
  | C3  | G6 upgraded to the local-midnight straddle; caveat removed       | §7 G6                                                                  |
  | C4  | `timestamptz` recorded as a tracked follow-up **with a trigger** | §8                                                                     |
  | C5  | Session `TimeZone` canary                                        | `db.integration.test.ts`, scoped honestly                              |
  | C6  | `dateTime` byte-identical across zones, variants, renderers      | `timestamp.test.tsx`                                                   |
  | C7  | Pre-existing SSR assertions unchanged                            | verified; one file gained a TZ pin — reported in the PR, not justified |
  | C8  | No timezone cookie, no `x-vercel-ip-timezone`                    | client-side `resolvedOptions()` only                                   |

  **Two of its findings changed the design rather than ratifying it**, and both
  were things I had got wrong:

  - **C1.** I had reasoned that pinning `en-GB` made `short` safe. It does —
    _by CLDR coincidence_. Under `en-US`, `America/Chicago` renders `CST`, which
    is equally China Standard Time (+8), US Central (−6) and Cuba. Since this
    story is precisely the one that invites someone to reach for the viewer's
    locale, the label is now an offset, which cannot be ambiguous in any locale.
  - **C3.** I had recorded G6 as "guards an absence, therefore not
    red-provable". That was wrong: it guards a _property_ (zone-invariance), and
    a realistic mutant exists — a future "make `yesterday` mean calendar
    yesterday" refactor. The fixture now straddles local midnight in Nairobi and
    not in Los Angeles, and that mutant dies. The caveat is withdrawn.

  It also corrected the **framing** of the DPA argument in this section, which
  is amended above: a timezone cookie is not unlawful, it "buys a legal review
  you have no need to buy". Two engineering reasons kill it independently — it
  does not remove the client component (there is no cookie on the first
  request), and it makes HTML vary by viewer zone, which AM-06's planned service
  worker would cache and replay across zones.

  **Process note.** The ruling arrived late: three messages went unanswered for
  ~30 minutes, and mid-flight I invoked the CLAUDE.md fallback with Kelvin's
  recorded decision. The cause was that the agent's earlier replies were sent in
  a form that never reached this session, not a stall. **The fallback is
  therefore superseded and is not what this story merges on** — a real ruling
  displaces it, and nothing had been merged. The guard list was nonetheless
  enumerated in this document before implementation (`99db4b1`, which precedes
  every `src/` commit on the branch), so the substitute route was genuinely
  available rather than merely asserted. Precedent for it:
  `docs/features/AM-09/DESIGN.md` §7.

## 6. Migration & rollout

**No migration. No rollout steps. Nothing to roll back.** The section below is
retained as the analysis a future consult should start from, not as work this
story does.

- **Steps.** One migration, additive in effect: the `timestamptz` conversions,
  then the two `date` conversions. No backfill — `USING … AT TIME ZONE 'UTC'`
  converts in place, and every existing value is already UTC.
- **Rows written during it.** Postgres takes an `ACCESS EXCLUSIVE` lock per
  table for the duration. Tables are small (thousands of rows) and PG 12+ skips
  the rewrite for `timestamp → timestamptz` when the session zone is UTC, so
  this is short. Neon's session zone must be **confirmed UTC before running**,
  because that same condition also decides whether the conversion is correct.
- **Rollback.** Reversible: the inverse `ALTER … TYPE timestamp(3) USING "col" AT
TIME ZONE 'UTC'` restores the prior type and values exactly. Reverting the PR
  alone does **not** revert the migration — per LEARNINGS, a deployed migration
  outlives its commit.
- **Destructive changes:** none.

## 7. Verification plan

Full local suite (baseline before this work: 50 files, 675 tests, real-DB
included, green) plus the guards below. **Each is red-proven by deleting the
production line it defends and watching it fail** — per CLAUDE.md, a guard
written to satisfy a ruling fails the same way as any other.

**CI runs in UTC** (no `TZ` in `.github/workflows/ci.yml`), so a guard that
leans on the ambient zone passes trivially there and only ever bites locally —
the same class as the hand-edited-migration trap in LEARNINGS. **Every guard
below pins its zone explicitly.** Node honours a runtime `process.env.TZ`
change (verified: `Intl` and `Date` parsing both pick it up), which is what
makes G2 testable.

- [x] **G1 — calendar dates never shift.** `calendarDate` reads `21 Jun 2026`
      for a UTC-midnight value with the process zone forced to
      `Pacific/Kiritimati` (UTC+14), `Pacific/Midway` (UTC-11) and
      `Africa/Nairobi` (UTC+3). Red: deleted `timeZone: "UTC"` — **failed** with
      `20 Jun 2026`, the one-day shift this exists to prevent.
      The formatter had to move out of module scope to make this provable at
      all; a module-scope one caches the zone set at import time, so the test
      would have passed with the pin deleted (§3.3).
- [x] **G2 — the UTC-midnight pin holds.** With `TZ=Africa/Nairobi`, submitting
      `2026-03-15` stores exactly `2026-03-15T00:00:00.000Z`. Red: removed the
      `Z` from `optionalDate`'s template literal — **failed** with
      `2026-03-14T21:00:00.000Z`, a day early, which is the corruption this
      whole story risked introducing.
- [x] **G3 — the machine-readable value stays UTC.** `<time dateTime>` equals
      `value.toISOString()` in both variants under a non-UTC viewer zone. Red:
      pointed `dateTime` at the localised string — `timestamp.test.tsx`
      "always carries a UTC machine-readable dateTime" **failed**.
- [x] **G4 — the server render is UTC and says so.** The pre-existing
      assertions pass **unchanged**. Red: resolved the zone in a `useState`
      initialiser rather than an effect — "falls back to UTC where the viewer's
      zone is not yet known" **failed**, the markup leaking `GMT+3`.
      **Counted, not estimated** (an earlier revision said "14", which was a
      file count from an orientation grep, not an assertion count): **4 literal
      `… UTC` assertions** — `me/assignments:183`, `people/[id]:257`, and two in
      `assignment-card-list.test.tsx` — plus **6 in `admin/users`**, which since
      review B2 build their expected value from an independent oracle rather
      than from the code under test.
- [x] **G5 — the zone is always named.** The same instant formatted in three
      zones yields three different strings, each ending in a non-empty zone
      token. Red: dropped `timeZoneName` — 4 tests **failed**, the value
      rendering as `2026-08-02 00:00 ` with a trailing space and no zone.
- [x] **G6 — `relativeTime` stays zone-independent** (upgraded, advisor C3).
      A value three hours before `now`, positioned to straddle local midnight in
      `Africa/Nairobi` and not in `America/Los_Angeles`, reads `3 hours ago` in
      both. Red: reimplemented `yesterday` as local calendar-day arithmetic —
      **failed**, returning `yesterday` in Nairobi.
      The earlier version of this guard compared two zones on a three-day-old
      value, which no realistic mutant fails, and was recorded here as "not
      red-provable". **That was wrong** — it guards a property, not an absence.
- [x] **C1 — the zone label is an offset, never an abbreviation.** Every zone
      renders `GMT±N`; `UTC` is the one deliberate exception. Red: reverted
      `shortOffset` → `short`, **locale untouched** — **failed** on
      `Europe/London` (`BST`) and `Europe/Paris` (`CEST`).
      **The first version of this guard listed only zones that render as
      offsets under `short` too** (Chicago, New York, Shanghai, Nairobi), so it
      stayed green on a one-line revert and only failed under a two-part
      mutation that also changed the locale — the #14 shape, caught at review
      (B3). CLAUDE.md's rule is deletion of _the_ production line, not an
      arbitrary edit near it; London and Paris are what make that true here.
- [x] **C2 — DST is applied per instant.** New York renders `GMT-5` in January
      and `GMT-4` in July. Red: hoisted the label out of the per-row path,
      computing it once per zone from a fixed instant — **failed**, July
      rendering `GMT-5`.
- [x] **C6 — `dateTime` is byte-identical across zones, variants, renderers.**
      Two opposite-sign zones × both variants × server and client, with a
      control on the visible text. Red: made the component ignore the viewer's
      zone — **failed**, the control seeing 2 distinct strings where 3 are
      required.
      **The control asserted `size > 1` until review B4 and was vacuous** — the
      relative variant renders `3 days ago` in both zones, so the two _variants_
      alone cleared the bar and a zone-blind component passed. An earlier
      revision of this section claimed the control prevented exactly that; it
      did not. It is now an exact `size === 3`, and the claim is true.
- [x] **B1 (review) — a missing zone can never become the ambient one.**
      `exactTimestamp` applies the UTC fallback itself; undefined, null and `""`
      all render `UTC` even under a poisoned ambient `TZ`. Red: removed
      `|| "UTC"` — **failed** with `2026-08-01 21:21 GMT+0`.
      `Intl` treats `{ timeZone: undefined }` as _absent_, not invalid, and
      falls through to the machine's zone. The guard had lived only at the call
      sites, so a single forgetful caller reintroduced it silently. **The
      fallback is a property of the formatter, not a convention among callers.**
- [x] **B2 (review) — the SSR assertions do not grade their own homework.**
      `admin/users/page.integration.test.tsx` built its expected value by
      calling the code under test, so both sides agreed whatever that code did —
      demonstrated when a formatter regression failed the literal-string files
      and left this one green. It now uses an independent oracle, which must not
      be refactored to share code with `exactTimestamp`. Red: broke the UTC
      label — **failed** 4 tests, where the old form passed.
- **G7 — withdrawn with the storage change.** It guarded the migration; there
  is no migration. Re-instate it with the deferred story (§8).

**On zone choice in the guards** (advisor). The two hazards break under
_opposite_ offsets: the display hazard (UTC midnight read in the viewer's zone)
breaks west of UTC and is safe in Nairobi; the input hazard (local midnight
truncated to a UTC date) breaks east of UTC and is safe in New York. Neither
zone alone proves both, and `TZ=UTC` — what CI runs — proves neither. G1 spans
UTC+14/UTC−11/UTC+3, G2 pins Nairobi, and G6/C6 pin Nairobi against Los Angeles.

### Verified in a real browser

jsdom proves markup, never behaviour, and two claims above are behavioural.
Checked signed-in against local Postgres, Chromium in `Europe/London`:

- The swap happens and is **DST-correct on the same page** — a July event reads
  `2026-07-31 23:08 GMT+1`, a December one `2025-12-08 22:08 GMT+0`. An offset
  computed once and reused would have got the second wrong. (Re-run after C1
  changed the label form; the pre-C1 run read `BST` and `GMT` on the same rows.)
- `dateTime` stayed `2026-07-31T22:08:42.369Z`; the purchase and warranty dates
  stayed `31 Jul 2026` / `14 Jan 2026`.
- **Zero console errors and zero warnings**, which is the actual test of the
  no-hydration-mismatch claim — React logs those loudly in dev and would have
  said so here.
- The deactivation prose reads `deactivated on 2026-07-01 10:30 BST` with
  `querySelectorAll("*")` inside the paragraph returning `[]` — the client
  boundary moved without introducing the element wrapper that paragraph refuses.

There are no advisor conditions to answer, because there is no ruling. §5
records what stands in their place and why that is the documented substitute
rather than a shortcut.

## 8. Rejected scope

- **The `timestamptz` / `@db.Date` storage migration — DEFERRED, not rejected.**
  The analysis in §1 and §6 stands and should be the starting point. It needs
  its own story, its own advisor consult, and guard G7.

  **Trigger (advisor C4) — do it at the first of these, not "someday":**

  1. The first **backfill migration** that touches a timestamp column. An
     `UPDATE … SET x = CURRENT_TIMESTAMP` is in-repo, is not insert-shaped, and
     no guard here sees it.
  2. The first **manual psql or GUI data fix against production**. DataGrip and
     TablePlus commonly set the session zone to the operator's local one, and on
     a register with no delete path and no correction UI, manual intervention is
     the documented escape hatch rather than an exotic event.

  The advisor's reasoning for deferring, recorded because it inverts the
  intuition: the migration would introduce a **live** risk to close a **dormant**
  one — a reversed `USING … AT TIME ZONE 'UTC'` silently shifts the entire audit
  history by the session offset, against tables this codebase forbids updating.

  **A bare `DROP DEFAULT` is not an acceptable substitute.** Prisma sees that as
  drift and will re-add the default on the next `migrate dev` — unlike the
  hand-written `Asset_tag_required_when_tracked` CHECK block, which it is blind
  to and therefore leaves alone.

- **`scripts/import-assets.ts` and the session advisory lock — FOUND HERE, NOT
  FIXED HERE.** Diagnosing a CI flake that blocked this PR turned up a real
  defect in AM-04's lock handling. `withImportLock` takes a session-scoped
  `pg_advisory_lock`, and **Prisma keeps a client-side connection pool even
  against an unpooled URL**, so the unlock can be delivered to a different
  backend than the lock. It then returns `false` — silently — and the lock
  survives. Measured on this repo's Postgres 17:

  ```
  default pool        lockPid=15133 unlockPid=15136 released=false  LEAKED
  connection_limit=1  lockPid=15150 unlockPid=15150 released=true   clean
  ```

  `withImportLock`'s `try/finally` is correct and never was the problem. The
  docblock's claim that a session lock "REQUIRES an unpooled connection" is
  **necessary but not sufficient** — it rules out PgBouncer moving the session,
  not Prisma's own pool.

  **The test clients are fixed in this PR** (`test/session-lock-client.ts`),
  because the flake blocked this merge and Kelvin scoped that fix here.
  `scripts/import-assets.ts:210` is **not** changed: it builds a plain
  `PrismaClient` with the same hazard, and it is AM-04 production code that a
  timezone story should not be quietly editing. It is not currently a live
  outage — the CLI does one run per process and exit closes the connection,
  releasing the lock — but the mutual-exclusion guarantee it advertises is
  weaker than it claims, and a second `withImportLock` in one process would
  block forever. **Fix: build that client from `singleConnectionUrl`, and
  correct the docblock.**

- **Per-user timezone preference** (schema + settings UI) — the browser already
  knows the right answer.
- **Timezone cookie / server-side localisation** — §4, §5.
- **Reformatting calendar dates** to a viewer-relative form — they are not
  instants and must not become them.
- **A date-picker component** — `<input type="date">` stays; G2 guards its
  parse.
- **Backfilling a zone onto historical events** — the events record instants;
  the zone they were _entered_ in is not recorded and cannot be recovered.
