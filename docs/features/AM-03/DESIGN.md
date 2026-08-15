# AM-03 Design — Assignment and Returns

**Tier: T3** (re-tiered from the PRD's T2). AM-03 opens the first row-level authorisation
surface over staff personal data and the first UI that shows one person's data to another.
PII floors at T3 per `CLAUDE.md`; advisor ruling below is the design gate, and a **second
advisor security review on the diff is required before merge**, as AM-01 had.

**Advisor ruling:** APPROVE WITH CONDITIONS (18 conditions, reproduced as §Conditions).
**ADR:** not required — this extends ADR-001's stack and AM-01's authorisation model rather
than altering either.

---

## 1. What the story is

> _As the IT admin, I can assign an asset to a member of staff and take it back with a
> condition note, so "who has what, and in what state" is always answerable._

| #    | Acceptance criterion                                                                       |
| ---- | ------------------------------------------------------------------------------------------ |
| AC-1 | An asset cannot be assigned to two people at once (database constraint, real DB).          |
| AC-2 | Return captures a condition note; repair-bound returns transition to `IN_REPAIR`.          |
| AC-3 | Per-asset history (every holder, every repair) and per-person view ("everything X holds"). |
| AC-4 | A staff user can see their own assignments; nobody else's details beyond name.             |

AM-04 (import), AM-05 (finance export), AM-06 (PWA) and AM-07 (search) all depend on this
story. Decisions here that are expensive to reverse are flagged as such in §9.

---

## 2. Decisions needing Kelvin's explicit sign-off

Two of these interpret an AC rather than implement it. They are the reason this document
exists; everything else is engineering.

### 2.1 `STAFF_RO` sees no person data anywhere except their own `/me/assignments` ⚠️

AC-3 wants per-asset history showing _every holder_. AC-4 says a staff user sees "nobody
else's details beyond name". Read together, the tempting implementation gives every
read-only staff member a browsable custody map of the organisation's kit.

**Ruling: it does not.** A `STAFF_RO` user opening an asset detail page sees **no current
holder and no holder history**. The assignment data is **not fetched** for that viewer —
not merely unrendered — so a later UI change cannot leak it.

Rationale: AC-3 is written from the IT admin's perspective (_"As the IT admin…"_) and is
fully satisfied by serving `ADMIN_IT` / `PROCUREMENT` / `FINANCE`. AC-4's "beyond name"
governs the **self** view, where a name may appear incidentally; it is not a licence to
publish who holds what. That map is a theft and social-engineering aid, and we have claimed
data minimisation **in writing** in `docs/DPA-TRANSFER-NOTE.md`.

**This is the costly-to-reverse one.** Widening it later requires a DPA note review — which
the note's own "review this note if scope changes" clause already mandates. If the client
actually wants staff to see "who has this", say so now and it is a different design.

### 2.2 Which roles may assign and return

Recommendation: **`ADMIN_IT` + `PROCUREMENT`**, identical to every other write action in
`src/app/assets/actions.ts`. Both roles already see person names and `employeeRef` under
§4.3, so it grants no visibility the read gate doesn't. The alternative — `ADMIN_IT` only,
matching the story's literal "As the IT admin" — is defensible but introduces a third role
matrix into a codebase that currently has two, and procurement handing out newly received
kit is a real workflow. **Say if you want `ADMIN_IT` only.**

---

## 3. Data model

### 3.1 The constraint that satisfies AC-1

Hand-written into the `am03_assignment` migration with a preserved comment block, exactly as
the AM-02 tag CHECK was handled (Prisma has no partial-unique primitive):

```sql
CREATE UNIQUE INDEX "Assignment_one_open_per_asset"
  ON "Assignment"("assetId") WHERE "returnedAt" IS NULL;

ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_returned_after_checkout"
  CHECK ("returnedAt" IS NULL OR "returnedAt" >= "checkedOutAt");
```

The partial predicate is load-bearing: a plain `UNIQUE("assetId")` would pass the
"can't assign twice" test while making every asset **permanently unassignable after its
first return**. §6 tests that explicitly.

The date CHECK is one line now and saves AM-04 from silently importing inverted dates.

### 3.2 What SQL does and does not enforce — stated plainly, not over-claimed

- **SQL enforces:** at most one open assignment per asset. That is AC-1's trust gate.
- **SQL does not enforce:** the coupling between `Asset.status = ASSIGNED` and the existence
  of an open assignment. A CHECK cannot reference another table, and the declarative
  alternatives split one invariant across two places Prisma cannot see. **It stays a
  transactional invariant.**

Direction of truth, because everything downstream depends on it:

> **The open `Assignment` row is the source of truth for holdership. `Asset.status = ASSIGNED`
> is a transactionally-maintained projection of it. When they disagree, the assignment wins.**

Residual risk, accepted and not eliminated: direct SQL or a future path bypassing
`asset-admin.ts` can desynchronise them. Mitigated by a reconciliation query (§6, also a
runbook query), not by a constraint.

### 3.3 Schema additions

```prisma
model AssetEvent {
  // …existing fields
  assignmentId String?
  assignment   Assignment? @relation(fields: [assignmentId], references: [id], onDelete: Restrict)
}
```

`onDelete: Restrict`, consistent with `actorId`. **This exists to keep PII out of the
append-only table.** Without it, the `ASSIGNED` event can only record _who_ as free text in
`notes` — putting a copy of a person's name into a table that is never updated and never
deleted, where a name change or a DPA erasure request is unhonourable by construction. The
FK keeps exactly one copy of the person link (on `Assignment`) and makes history renderable
by join.

**Standing rule, added to `CLAUDE.md`:** no personal data — names, emails, employee refs — is
ever written into `AssetEvent.notes` or any `UserEvent` field.

### 3.4 `Assignment` mutability — a bounded exception to the append-only rule

Verbatim, for `CLAUDE.md`:

> `Assignment` is a **state** row, not an audit row. Exactly two columns are mutable —
> `returnedAt` and `conditionNotes` — set exactly once, by the return path, on a row where
> `returnedAt IS NULL`. Every other column is write-once at insert; `Assignment` rows are
> never deleted. The audit anchor is the `ASSIGNED`/`RETURNED` `AssetEvent` pair.
> `AssetEvent` and `UserEvent` remain append-only and this exception does not extend to them.

The exception is made self-limiting by its enforcement: the update is **predicated on
`returnedAt IS NULL`** — `updateMany({ where: { id, returnedAt: null } })` asserting
`count === 1` and throwing otherwise. The two mutable columns can only ever be written to a
row that is still open. Application-enforced, not DB-enforced.

> **Correction (security review, F1).** An earlier draft of this section claimed the
> predicate "is what survives someone later deleting the lock". **It does not, and the
> claim was verified false.** Without the asset row lock, the losing transaction's
> `findFirst` sees the row already closed, returns null, and takes the documented "proceed"
> branch — `count === 1` is never reached, and a second transition commits against an
> already-returned asset (with `FOR UPDATE` removed, the concurrent-double-return test fails
> with two events, not one). The lock is the **only** thing preventing that. The predicate
> defends one narrow interleaving inside the lock's window, which with the lock present
> cannot occur at all. Both are kept; neither is defence in depth for the other. A false
> safety claim in a comment is how the lock gets deleted two stories from now.

---

## 4. Behaviour

### 4.1 Transaction composition and locking

`transitionAssetStatus` currently opens its own `$transaction`, so assignment cannot call it
without nesting. **Refactor: extract a tx-scoped core.**

```
transitionAssetStatusTx(tx, input)   ← lock + guard + tag check + update + event
transitionAssetStatus(db, input, testHooks)  ← thin $transaction wrapper (unchanged API)
assignAsset(db, input)     ← own $transaction, calls the core
returnAsset(db, input)     ← own $transaction, calls the core
```

Explicitly rejected: duplicating the guard (two copies diverge; the transition map is the
single source of truth per `CLAUDE.md`), and making the parameter
`PrismaClient | TransactionClient` with a branch (makes the transaction boundary implicit at
the call site and permits a caller who is silently not in one).

**`lockAsset`'s `SELECT … FOR UPDATE` is required, and the unique index is not a substitute.**
The index protects exactly one race — two concurrent inserts for the same asset. It does
nothing for assign-vs-`sendToRepair`, assign-vs-`retireAsset`, or two concurrent returns. All
three are reachable from the UI.

> **The Asset row lock is the mutex for that asset's assignment rows.** Every path that
> writes an `Assignment` takes it **first**, before touching `Assignment`. Uniform lock
> ordering is not optional — assign taking Asset→Assignment while return takes
> Assignment→Asset is a deadlock cycle, and under Neon those surface as intermittent
> production failures. Because the lock is always taken first, no `Assignment` row needs its
> own `FOR UPDATE`.

**Transaction budget.** Verified against the pinned `@prisma/client@6.19.3` (not recalled):
interactive-transaction defaults are `maxWait` **2000 ms** and `timeout` **5000 ms**, and
`src/lib/db.ts` configures neither. AM-03's transactions are the longest in the codebase, so:
nothing slow runs inside them — no `revalidatePath`, no email, no picker queries.

### 4.2 Every transition out of `ASSIGNED` closes the open assignment

`ASSIGNED → IN_REPAIR` and `ASSIGNED → RETIRED` are already legal and `sendToRepair` /
`retireAsset` are already live, with no knowledge of assignments. The moment AM-03 creates
open assignments, those actions strand them — the register would show a retired laptop still
held by a named person.

**Every transition out of `ASSIGNED` closes the open assignment in the same transaction.** No
"return it first" rejection: forcing a two-step return on a stolen laptop trains operators to
record a fictional "returned to stock".

**Consequence:** on an `ASSIGNED` asset, sending to repair **is** the repair-bound return of
AC-2, not a second parallel path. **AM-03 modifies the shipped AM-02 actions** — that is
scope, not scope creep.

### 4.3 Event granularity — exactly one `AssetEvent` per action, never two

| Action closes an open assignment | → event type     |
| -------------------------------- | ---------------- |
| opens one                        | `ASSIGNED`       |
| closes one                       | `RETURNED`       |
| neither                          | `STATUS_CHANGED` |

So retiring an assigned asset writes a **single** `RETURNED` event with
`fromStatus=ASSIGNED, toStatus=RETIRED`. The event type names the intent;
`fromStatus`/`toStatus` already carry the status fact, so a second row adds no information
and forces every reader (detail page, AM-05 export, AM-07) to de-duplicate.

**Corollary the readers must honour: status questions query `fromStatus`/`toStatus`, never
event type.**

This forces a signature detail — `transitionAssetStatusTx` takes the event type as a
parameter (default `STATUS_CHANGED`). Without it, the refactor mechanically produces two
events and re-introduces the problem it was meant to avoid.

### 4.4 Condition capture on return (AC-2)

- The **`AssetCondition` enum is mandatory on every return.** It is the structured field that
  answers "in what state", it is one click, and it updates `Asset.condition` in the same
  transaction.
- The **free-text `conditionNotes` is mandatory for repair-bound returns and for
  `POOR`/`DEFECTIVE`**, optional otherwise. Forcing prose on every routine "GOOD, back on the
  shelf" return trains operators to type "ok" and destroys the signal.

AC-2 is satisfied: the condition is always captured.

**No condition note at assign time.** The asset's condition at handout is already
`Asset.condition`; a second field is a place for the two to disagree. An optional free-text
`notes` on assign is fine — it goes to the `ASSIGNED` event's `notes`, never onto the
`Assignment` row, and never contains personal data (§3.3).

### 4.5 Leavers

- An asset **may not** be assigned to a person whose linked `User` is deactivated — rejected
  in the app layer **inside the transaction**, with a real-DB test. Cross-table and mutable
  after the fact, so not a DB constraint.
- A person with **no `User` at all remains fully assignable** — contractors and staff without
  logins are real. The rule is narrow: reject only when a linked `User` exists **and**
  `deactivatedAt IS NOT NULL`.
- **Enforcement against a leaver's existing open assignments is out of scope, deliberately.**
  Blocking deactivation on outstanding assets would be a **security regression** — the AM-01
  kill-switch must never be blockable by asset state, or a departing employee with an
  unreturned laptop cannot be locked out. Auto-returning would fabricate a return that never
  happened. Neither. Recorded as **AM-03-CF-2** so nobody "fixes" it later.
- **In scope:** the person view shows a deactivated marker. One boolean in a select we are
  making anyway, and it makes the leaver hole visible rather than invisible.

---

## 5. Authorisation and PII

### 5.1 The primitive: self-scoped routes, no identifier input

`requireRole` is role-only and cannot express AC-4. Rather than add a second helper whose
correct use is unverifiable, the scoping is **structural**:

| Route             | Gate                                 | Person scope                                               |
| ----------------- | ------------------------------------ | ---------------------------------------------------------- |
| `/me/assignments` | all four roles                       | derived server-side from `session.user.id → User.personId` |
| `/people/[id]`    | `ADMIN_IT`, `PROCUREMENT`, `FINANCE` | the `id` in the path                                       |

**`/me/assignments` accepts no person identifier from params, searchParams, or form data.**
No IDOR surface exists because there is nothing to tamper with — and that is verifiable by
grep, the same property that makes `requireRole` reviewable. `User.personId === null` is an
empty state, not a 500.

Rejected: passing a `viewerPersonId` into the query layer ("did the caller pass the scope?"
is not mechanically verifiable, and a missing scope argument is precisely the structural IDOR
in LEARNINGS §Prisma). Rejected: `requireSelfOrRole` alone (authorises the request but leaves
each query hand-written, so a later refactor widens the query without touching the helper).

**`/people/[id]` IDOR:** the role gate is correct and sufficient. Enumerable cuids are not a
vulnerability when every reader of the route is authorised by role to read every person.
Stated here so review does not relitigate it.

### 5.2 Field visibility — three tiers, one function, enforced in the Prisma `select`

| Field                | ADMIN_IT | PROCUREMENT | FINANCE | STAFF_RO |
| -------------------- | -------- | ----------- | ------- | -------- |
| `Person.name`        | ✅       | ✅          | ✅      | own only |
| `Person.employeeRef` | ✅       | ✅          | ✅      | ❌       |
| `Person.email`       | ✅       | ❌          | ❌      | ❌       |

`employeeRef`, not email, is the picker's disambiguator for two staff with the same name: it
is the organisation's own internal number — the field the brief chose _instead of_ a national
ID — and unlike an email it cannot be used to contact or enumerate anyone outside the tool.
Email has no operational purpose in assignment.

`FINANCE` is on the person view deliberately: AM-05 gives finance an export built on this
data, and granting the export while denying the screen is incoherent.

**This lives in exactly one exported helper — `personSelectFor(role)` in
`src/lib/person-visibility.ts` — which is the only place in the codebase a `Person` select
**carrying PII** is written.** That singularity is what makes it verifiable the way
`requireRole` is. Enforced in the `select`, never in JSX.

The qualification is load-bearing, not hedging (review finding). Two selects legitimately sit
outside the helper: `/admin/users` (an `employeeRef`-only select on an `ADMIN_IT` route,
narrower than the helper would give) and the leaver guard in `asset-admin.ts` (no PII field,
and written as `tx.person.findUnique`, which the obvious grep shape does not even match). An
audit instruction that produces an unexplained false positive on its first use teaches the
next reviewer to skim — which destroys the property the singularity exists for. The module's
docblock names both and gives the grep that catches both shapes.

`PERSON_NAME_SELECT`, in the same module, is the narrow projection for surfaces that display
only a name: it contains no field any role is denied, so no role check applies to it.

### 5.3 An existing leak AM-03 closes

`src/app/assets/[id]/page.tsx:81` selects `actor: { select: { name: true, email: true } }` and
line 192 renders `event.actor?.name ?? event.actor?.email` **for all four roles** — so any
actor without a `name` currently exposes their email address to every staff user. Verified
present on `main`.

Actor identity follows the same tier rule: email is selected only for `ADMIN_IT`, and for
`STAFF_RO` the actor is not selected at all — the "Who" column renders a neutral label. A
`STAFF_RO` user still sees the asset's status history; they see no person on it.

---

## 6. Verification

Real-DB integration tests (`describe.skipIf(!process.env.TEST_DATABASE_URL)`) — mocks cannot
guard these seams. The barrier seam already exists at
`src/lib/asset-admin.integration.test.ts:280`.

**Four concurrency tests. The ordering matters, and two of them are traps:**

1. **Designated lock proof — concurrent `assignAsset` + `sendToRepair` on one asset.** No
   index involvement, so nothing can mask a missing lock. **The engineer must report this
   empirically red with `FOR UPDATE` deleted — a claim is not a report** (AM-01's headline
   lesson).
2. **Concurrent double-assign to two different people.** Asserts the loser fails with
   **`IllegalTransitionError`, never P2002.** ⚠️ An assertion phrased as "one of them failed"
   **stays green with the lock removed**, because the index catches it — AM-01's
   race-test-passing-on-luck in new clothing, with the index as the thing that hides it.
3. **Index proven at the DB layer, app bypassed** (raw SQL insert of a second open assignment
   → 23505), mirroring AM-02's CHECK-bypass test — **plus its falsifiability twin: after a
   return, a second assignment must succeed.** Without the twin, a mistakenly non-partial
   unique passes test 3 while making every asset permanently unassignable. (AM-02's lesson:
   "proven red for NULL is not proven red for empty string" — same shape.)
4. **Concurrent double-return of one assignment:** exactly one succeeds, exactly one
   `RETURNED` event, and `returnedAt`/`conditionNotes` still hold the **first** return's
   values. A second return silently overwriting the first is audit corruption, not a
   duplicate click.

**Reconciliation assertion** (also a runbook query): assets `ASSIGNED` with no open
assignment, and open assignments on non-`ASSIGNED` assets — both return zero rows.

**Also covered:** assignment to a deactivated-`User` person rejected; person with no `User`
assignable; single-event rule per §4.3 (retiring an assigned asset → exactly one `RETURNED`);
`ASSIGNED`/`RETURNED` events carry `assignmentId`; role matrix on every new action and route;
**no assignment or person data in the payload for a `STAFF_RO` viewer** (asserted on the query
result, not the rendered HTML).

Commands, each with an explicit `DATABASE_URL` override — never bare, `.env` holds the
**production** URL and Prisma autoloads it (AM-01 retro §5): `pnpm lint`, `pnpm typecheck`,
`pnpm test` with `TEST_DATABASE_URL` set, `pnpm build` with **zero env populated**.

---

## 7. Scope

**In:** the migration; the tx-core refactor; `assignAsset`/`returnAsset`; modifying
`sendToRepair`/`retireAsset` to close open assignments; `personSelectFor`; assign/return UI on
the asset detail page; holder column on the register (privileged roles); `/people/[id]`;
`/me/assignments`; the actor-email fix; `CLAUDE.md` + DPA note updates.

**Out, named:** Person admin/CRUD (**AM-03-CF-1**) — new PII _write_ surface, T3 in its own
right. The picker lists existing `Person` rows, including those without a `User`.
**Honest hole:** a `Person` with **no** `User` can currently only be created by re-running the
staff seed CSV, so "assign to the contractor who has no login" is unserviceable unless they
were seeded. Workaround: re-run the seed with an updated CSV, or provision them as
`STAFF_RO` via `/admin/users`.

Also out: pagination on the person view and per-asset history (AM-02's carry-forward now
extends to both).

---

## 8. Carry-forwards

- **AM-03-CF-1 — Person admin.** AM-04 may force this: if the legacy export names
  assignees who are not seeded staff, someone must create them, and "reported, never silently
  dropped" then means AM-04 needs the screen.
- **AM-03-CF-2 — Leaver open assignments.** No enforcement, by design (§4.5). Natural home is
  AM-07's dashboard ("assets held by deactivated users"); the data supports the query today.
- **Into AM-04, and it must be in AM-04's plan before implementation:** the import inserts an
  **open `Assignment` directly**, with `checkedOutAt` from the source data, plus the reserved
  `IMPORTED` event. It must **not** call `assignAsset`, which would fabricate an `ASSIGNED`
  event dated today for a transition that never happened. **Binding on this design: structure
  the assignment write so an import path can insert an open assignment without passing through
  the lifecycle guard.** This is the `INITIAL_ASSET_STATUSES` trap from AM-02, one story
  later — do not rebuild it.
- **Into AM-05:** the export's columns consume the same `personSelectFor` tiers. A finance CSV
  carrying staff emails would contradict §5.2 and the DPA note.
- **Into AM-07:** "role-filtered" search is load-bearing. **`STAFF_RO` must not be able to
  search by person name at all** — otherwise §2.1's redaction is bypassed in one query
  ("search Jane → see Jane's laptop"). **Sharpened by the security review:** if AM-07
  indexes `AssetEvent.notes`, every operator-typed name in that column becomes findable by
  `STAFF_RO` — a far sharper bypass than the name search, because the notes column is
  append-only and cannot be corrected. Either exclude `notes` from any `STAFF_RO`-reachable
  search, or close the F3 channel properly first.

### Added by the security review on the diff (PASS WITH CONDITIONS)

- **AM-04-CF-A — resolved in this PR, not deferred.** `createOpenAssignmentTx` now takes the
  asset row lock itself. `lockAsset` is private, so an external caller could not have
  honoured a "caller must hold the lock" contract without duplicating the raw SQL, which is
  exactly how uniform lock ordering breaks. Re-entrant, so the core path does not block — it
  pays one extra indexed round-trip, which is the right price for a seam that is safe by
  construction rather than by comment.
  **Binding on AM-04:** a bulk import calling this in a loop takes one row lock per asset, so
  it must iterate in a **deterministic order (sort by `assetId`)**. Two concurrent imports
  over overlapping sets in opposite orders would otherwise deadlock — and "run the import
  again while the first is still going" is exactly what a nervous operator does.
- **AM-04-CF-B.** AM-04's write paths must be brought inside the **scoped** reconciliation
  assertion (`src/lib/assignment.integration.test.ts`), or it silently narrows as the
  codebase grows around it.
- **AM-03-CF-3.** If a one-step reassign is ever built (close one assignment and open another
  in a single transition), revisit `eventTypeFor`: with both an opened and a closed
  assignment it returns `ASSIGNED` and keeps only the opened link, dropping the closed one.
  Unreachable today — `ASSIGNED → ASSIGNED` fails the lifecycle guard first.
- **F3, accepted residual risk.** `AssetEvent.notes` is operator-typed free text rendered to
  all four roles including `STAFF_RO`, and the table is never updated or deleted. The code
  never writes personal data there; an operator can. Mitigated by a hint on every form that
  writes it and by the `CLAUDE.md` entry, both of which are guidance, not enforcement. This
  is the one channel through which §2.1's redaction can be bypassed.

---

## 9. Reversibility

Cheap: the index, the tx-core refactor, the event-type rule.
**Costly, ruled deliberately:** §2.1's `STAFF_RO` visibility line (widening later needs a DPA
review) and `AssetEvent.assignmentId` (retrofitting a link onto an append-only table cannot
backfill history).

---

## Conditions (advisor — verifiable at review)

1. Partial unique index hand-written with a preserved comment block; design states SQL
   enforces one-open-assignment-per-asset and **does not** enforce the status coupling.
2. `transitionAssetStatusTx(tx, …)` extracted; `transitionAssetStatus` a thin wrapper; **no
   function accepts `PrismaClient | TransactionClient`**; the core takes the event type as a
   parameter.
3. Every function writing an `Assignment` calls `lockAsset` **first**. Uniform lock ordering.
4. Exactly one `AssetEvent` per action per §4.3. Status questions query `fromStatus`/
   `toStatus`, never event type.
5. Every transition out of `ASSIGNED` closes the open assignment in the same transaction;
   `sendToRepair`/`retireAsset` modified accordingly.
6. Four concurrency tests per §6; test 1 reported **empirically red** with `FOR UPDATE`
   deleted; test 2 asserts `IllegalTransitionError`, never P2002; test 3 has its post-return
   twin; plus the reconciliation assertion.
7. `CHECK ("returnedAt" IS NULL OR "returnedAt" >= "checkedOutAt")` in the same migration.
8. `personSelectFor(role)` is the **only** place a `Person` select is written; §5.2 enforced
   in the `select`, never in JSX.
9. No assignment or person data **fetched** for a `STAFF_RO` viewer on `/assets` or
   `/assets/[id]` — role-conditional at the query.
10. `/me/assignments` reads no person identifier from request input. Grep-verifiable.
11. The actor-email leak at `page.tsx:81,192` closed under the same tier rule.
12. Deactivated-`User` assignment rejected inside the transaction (real-DB test); no-`User`
    person assignable (real-DB test); person view shows a deactivated marker.
13. The return update is predicated on `returnedAt IS NULL` with a `count === 1` assertion.
14. `AssetEvent.assignmentId` FK added (`onDelete: Restrict`). No personal data in
    `AssetEvent.notes`.
15. `CLAUDE.md` gains, in the same PR: the `Assignment` mutability rule (§3.4 verbatim), the
    single-event rule, the `STAFF_RO`-sees-no-person-data rule, the no-PII-in-events rule.
16. `docs/DPA-TRANSFER-NOTE.md` gains a line recording the role-based visibility tiers as the
    technical measure implementing the minimisation claim. Stored fields do not change, so no
    new transfer — but the note's own "review if scope changes" clause is triggered by the
    display change.
17. Nothing slow inside the assign/return transactions; Prisma 6.19.3 defaults verified
    (`maxWait` 2000 ms, `timeout` 5000 ms, unconfigured) — §4.1.
18. `revalidatePath` covers `/people/[id]` and `/me/assignments` alongside `/assets` and
    `/assets/[id]`.
