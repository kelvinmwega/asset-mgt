# Design: AM-10 — timestamps in the viewer's timezone

**Slug:** `AM-10`
**Tier:** T3 — deliberate reversal of a shipped audit-rendering decision
(AM-09 §4.3). The candidate data migration that also carried the tier has been
**dropped from scope** — see §6.
**Advisor consult:** **non-responsive; CLAUDE.md fallback invoked** — see §5.
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
  timezone cookie would be a genuinely different act: a new client-derived
  signal about the person crossing the wire and landing in request logs. That
  asymmetry is why the cookie is rejected in §4 rather than merely deprioritised.
  (ii) No new data is displayed — the same instants render, in a different zone,
  so the DPA note's "displayed rather than stored" trigger is examined and found
  not to fire. (iii) `STAFF_RO` person-data rules are untouched: timestamps are
  not person data and `personSelectFor` is not modified.
- **Tenant scoping:** not applicable — single-tenant register, no read or write
  path changes.
- **Secrets handling:** unchanged.
- **Advisor ruling:** **none — the agent was non-responsive.** Consulted
  2026-08-09 with a four-question T3 brief (storage proportionality, the
  calendar-date columns, per-viewer vs fixed-zone rendering, blast-radius
  conditions), followed by two further messages carrying verified probe results
  and a status check. No reply over ~30 minutes. This is the second occurrence;
  the first was AM-09, which is what put the fallback clause in CLAUDE.md, and
  that clause says to fall back rather than spend the session diagnosing it.

  **The T3 floor is therefore satisfied by the substitute route, all three
  parts:**

  1. **Guards enumerated in this document _before_ implementation** — §7 G1–G6,
     committed in `99db4b1` while the consult was still outstanding.
  2. **Kelvin's recorded decision naming that specific list** — 2026-08-09,
     choosing the fallback over waiting, and dropping the storage migration from
     scope on the grounds that its justification was the proportionality call
     that has no ruling.
  3. **Each guard proven red** — by deleting the production line it defends and
     watching it fail. Evidenced one-by-one in the PR body.

  Precedent and worked example: `docs/features/AM-09/DESIGN.md` §7.

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
- [x] **G4 — the server render is UTC and says so.** The 14 existing
      integration assertions on `"… UTC"` in server-rendered HTML pass
      **unchanged**. Red: resolved the zone in a `useState` initialiser rather
      than an effect — "falls back to UTC where the viewer's zone is not yet
      known" **failed**, the markup leaking `GMT+3`.
- [x] **G5 — the zone is always named.** The same instant formatted in three
      zones yields three different strings, each ending in a non-empty zone
      token. Red: dropped `timeZoneName` — 4 tests **failed**, the value
      rendering as `2026-08-02 00:00 ` with a trailing space and no zone.
- [x] **G6 — `relativeTime` stays zone-independent.** Identical output under
      `Pacific/Kiritimati` and `Pacific/Midway`; no zone parameter exists on it.
      **Not deletion-red-provable, and recorded as such rather than claimed**:
      it guards the _absence_ of a zone dependency, so there is no line to
      remove. It is a characterisation test and worth less than G1–G5.
- **G7 — withdrawn with the storage change.** It guarded the migration; there
  is no migration. Re-instate it with the deferred story (§8).

### Verified in a real browser

jsdom proves markup, never behaviour, and two claims above are behavioural.
Checked signed-in against local Postgres, Chromium in `Europe/London`:

- The swap happens and is **DST-correct on the same page** — a July event reads
  `2026-07-31 23:08 BST`, a December one `2025-12-08 22:08 GMT`. A fixed offset
  would have got the second wrong.
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
  its own story, its own advisor consult on proportionality, and guard G7. It is
  not urgent: storage is already reliably UTC through Prisma, and the path that
  would break it is unreachable from this codebase today. What would make it
  urgent is anyone adding a `$executeRaw` that inserts into a timestamp column,
  or a manual psql fix-up against production.
- **Per-user timezone preference** (schema + settings UI) — the browser already
  knows the right answer.
- **Timezone cookie / server-side localisation** — §4, §5.
- **Reformatting calendar dates** to a viewer-relative form — they are not
  instants and must not become them.
- **A date-picker component** — `<input type="date">` stays; G2 guards its
  parse.
- **Backfilling a zone onto historical events** — the events record instants;
  the zone they were _entered_ in is not recorded and cannot be recovered.
