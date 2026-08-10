# Retro: am-10-viewer-timezone

**Slug:** `am-10-viewer-timezone`
**PR:** [#38](https://github.com/kelvinmwega/asset-mgt/pull/38) — merged `8412a29`
**Tier:** T3 (assigned, held)
**Plan / design:** `docs/features/AM-10/DESIGN.md`
**Date:** 2026-08-10

## What shipped

Instants render in the viewer's own timezone with an unambiguous offset label
(`2026-08-01 21:21 GMT+3`); `<time dateTime>` keeps UTC ISO-8601 as the machine
anchor. The server, no-JS and first-client renders show UTC and say so, so the
swap to local is an ordinary post-mount re-render with no hydration mismatch.
Calendar dates (`purchasedAt`, `warrantyUntil`) moved into `@/lib/calendar-date`
and are pinned to UTC in one named place. **No schema change** — the storage
half was investigated, found already correct, and deliberately deferred.

## Plan versus reality

| Planned                                      | Actual                                                                     | Why it diverged                                                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Migrate 21 columns to `timestamptz`          | **Dropped**                                                                | Probing showed Prisma supplies `@default(now())` client-side as UTC, so the DDL defaults never fire. Defence-in-depth over a dormant path |
| Advisor consult → design → implement         | Consult appeared to stall 30 min; fallback invoked; ruling then arrived    | Subagent replies were being sent in a form that never reached the parent session. The fallback had to be superseded mid-delivery          |
| Guards G1–G6 enumerated up front, red-proven | Held — but **two of them did not actually guard** until review caught them | See below. The enumeration was right; the proofs were not                                                                                 |
| Rendering-only diff                          | Grew a `test/` helper and an AM-04 concurrency fix                         | A "flaky" CI failure turned out to be a real bug that blocked the merge                                                                   |

## What broke or surprised

1. **Two guards did not guard, and both were mine.** The C1 zone-label guard
   listed only zones (Chicago, New York, Shanghai, Nairobi) that render as
   `GMT±N` under `short` **and** `shortOffset` in `en-GB` — so reverting the
   production line alone left it green; it failed only under a two-part mutation
   that also changed the locale. And the C6 control asserted
   `expect(rendered.size).toBeGreaterThan(1)`, which the two _variants_ satisfied
   on their own: the relative variant renders `3 days ago` in both zones, so a
   component ignoring the viewer's zone entirely still produced 2 distinct
   strings and passed. **DESIGN §7 and the PR body both claimed that control
   would catch exactly that mutant.** Fixed to `toBe(3)` — and this is the same
   floors-not-exact-counts shape LEARNINGS already records from responsive-tables.

2. **A third guard was missing entirely.** I diagnosed and fixed a real
   concurrency bug and shipped nothing that would fail if the fix were removed —
   on a branch that had just added `test/time-zone.test.ts` on precisely the
   argument that a bug invisible where it is caused is protected by memory alone.

3. **The "flaky" CI failure was a real bug.** `import-run.integration.test.ts`
   failed 2 runs in 3, never locally, as a 20s test timeout followed by a 10s
   `$disconnect()` hook timeout. `withImportLock` takes a session-scoped
   `pg_advisory_lock`, and **Prisma keeps a client-side pool even against an
   unpooled URL**, so the unlock can be delivered to a different backend, return
   `false` silently, and leave the lock held. Measured: `lockPid=15133
unlockPid=15136 released=false` on a default pool; clean at
   `connection_limit=1`. It is a deadlock, not a lost mutex — the lock is
   over-held, so the next acquire in the process blocks forever. A CLI run does
   one import and exits, which hides it.

4. **A test-helper bug I nearly wrote off as a flake.** One full-suite failure
   passed on re-run. `process.env` coerces assigned values to strings, so the
   usual save/restore pair leaves `TZ="undefined"` whenever it started unset —
   the normal state locally and in CI. `Intl` then resolves the zone to
   `undefined`, and with `fileParallelism: false` that poisoned state leaks into
   every later file.

5. **Subagent replies can fail to arrive.** Three messages to the advisor went
   unanswered for ~30 minutes; I read it as the AM-09 stall recurring and invoked
   the CLAUDE.md fallback with Kelvin's recorded decision. The ruling then
   arrived in full — its earlier replies had been plain text that never reached
   this session. The same happened twice with the reviewer. Both recovered
   everything on a resend request.

6. **A reviewer reported a failure that was an artefact of my moving tree.** Its
   first report was run against a working copy I was actively editing. That is my
   error, not its: I spawned it mid-flight and then landed the advisor's
   conditions underneath it.

## What we would do differently

- **Brief a reviewer with a SHA, not a branch name.** A reviewer that executes
  tests needs a frozen ref, or its findings describe a tree that no longer exists.
- **Treat subagent silence as a delivery question before a liveness question.**
  A bare `idle_notification` with no content means "produced something you did
  not receive". Ask for a plain-text resend before falling back — falling back
  early cost a scope decision that then had to be reversed.
- **When a guard's red-proof needs more than one edit, it is not a red-proof.**
  Both AM-10 misses were visible from the proof note alone: C1's said "switch to
  `short` under `en-US`" — two changes, so the guard was never shown to defend
  the one line the condition names.
- **Keep the whole failing log, not the tail.** Not re-running until green is the
  right instinct; the missing half is keeping the evidence. One failure this
  delivery remains unexplained because its output was discarded.
- **Add guard-bearing modules to `stryker.config.mjs` in the same PR** — done
  here for `calendar-date.ts` and `relative-time.ts`, which is the mechanisation
  the recurrence deserves rather than another bullet.

## Lessons extracted

| Lesson                                   | LEARNINGS §       | Repeat?                                                                                |
| ---------------------------------------- | ----------------- | -------------------------------------------------------------------------------------- |
| Session locks leak through Prisma's pool | Prisma / Postgres | 1st                                                                                    |
| Restoring an absent env var              | Testing           | 1st                                                                                    |
| Timezone guards need opposite-sign zones | Testing           | 1st                                                                                    |
| `Intl` treats a missing zone as ambient  | Frontend / React  | 1st                                                                                    |
| Subagent replies can fail to arrive      | Tooling           | 2nd — AM-09's "advisor returned nothing" was almost certainly this, not a hang         |
| Guards that do not guard                 | Testing           | **~10th — NOT appended.** Mechanised instead: the two new modules are now in `mutate:` |

## Deliberately not appended

- **Another "regression guards must be falsifiable" bullet.** The existing entry
  is at six recurrences plus one, is marked MECHANISED, and says in terms: _do
  not add another bullet_. AM-10 supplies two more instances and one of them
  (`toBeGreaterThan` where an exact count was needed) is verbatim the shape
  responsive-tables already recorded. Adding a tenth restatement would be
  ceremony; extending the mutation scope is the action that changes an outcome.
- **The vitest sequencer ordering.** Sharpened the existing `fileParallelism:
false` bullet in place rather than adding one — the mechanism (failed-first,
  then longest-duration, then largest-file) belongs with the claim it corrects.
- **"Reverse a shipped design decision carefully."** True, feature-specific,
  and already fully recorded in `docs/features/AM-10/DESIGN.md` §5.
- **The unexplained full-suite failure.** Six-plus clean runs, no reproduction,
  and no surviving log. An open question recorded as open in the design doc; not
  a lesson until someone can say what it was.
