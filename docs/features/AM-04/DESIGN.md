# AM-04 — Legacy register migration import — DESIGN

- **Tier:** T3 (raised from the PRD's T2)
- **Story:** `docs/intake/asset-mgt/PRD.md` §AM-04
- **Source file:** the client's legacy export (kept out of the repo — §10)
- **Advisor ruling:** **PASS WITH CONDITIONS**, `AM-04-C1`…`C40` (§9), 2026-08-07

**Why T3, when the PRD says T2.** The PRD scoped AM-04 as "read the export,
write the assets". The actual file adds two things on CLAUDE.md's T3 floor:

1. **A migration.** Five export columns have no home, and two required columns
   (`Asset.make`, `Asset.model`) are _blank in the client's real data_.
2. **A PII write path.** `Assigned to` is a bare name. Importing it creates
   `Person` rows from a spreadsheet, widening the register's data subjects from
   provisioned staff to everyone named in a legacy export — including leavers.

---

## 1. What the export actually is

Not a data dump — an **legacy export template**: 1 header row, **21
columns**, **1 example data row**, 187 blank rows carrying only formatting.

The field _names_ are authoritative; the field _vocabulary_ is a sample of one.
Every decision below that depends on a column's value space is therefore a
decision about **how to behave when we meet a value we have never seen**.

> **`AM-04-C18` is a precondition on implementation, not a task inside it:** the
> full ~400-row export must be obtained and the mapping frozen **before** code
> is written. §4.2, §4.3 and §11 each contain a decision that cannot be made
> correctly from one row.

### 1.1 The row, and what the file says around it

| Column         | Value                                   | Cell facts                                                  |
| -------------- | --------------------------------------- | ----------------------------------------------------------- |
| Asset Tag ID   | `KE001771`                              | `t="s"`                                                     |
| Description    | `HP USB-C G5 Essential Docking Station` | `t="s"`                                                     |
| Purchased from | `Read technologies`                     | `t="s"`                                                     |
| Purchase Date  | `45177`                                 | `s="2"`, **bare numeric serial** → 2023-09-08               |
| Brand          | _(blank)_                               | **no `<c>` element at all**                                 |
| Cost           | `229.81`                                | `s="3" t="s"` — **shared string** in a `\$0.00`-styled cell |
| Model          | _(blank)_                               | **no `<c>` element**                                        |
| Serial No      | `5CG237TDXQ`                            | `t="s"`                                                     |
| PID            | _(blank)_                               | **no `<c>` element**                                        |
| Asset Type     | `CE`                                    | `t="s"`                                                     |
| City/Station   | `KE02`                                  | `t="s"`                                                     |
| CC             | `CC3200`                                | `t="s"`                                                     |
| P.O Number     | `PO220202300331`                        | `t="s"`                                                     |
| Site           | _(blank)_                               | **no `<c>` element**                                        |
| Location       | `IITA Nairobi ICIPE Office`             | `t="s"`                                                     |
| Category       | `DOCKING STATION`                       | `t="s"`                                                     |
| Department     | `Mitigate`                              | `t="s"`                                                     |
| Assigned to    | `Lindah Fatuma Kakai`                   | `t="s"`                                                     |
| Date Created   | `07/29/2024 07:08 AM`                   | `t="s"` — **string**, US format                             |
| Created by     | `Brian Kiana`                           | `t="s"`                                                     |
| Status         | `Available`                             | `t="s"`                                                     |

Workbook facts, all verified against the file: `<workbookPr>` carries **no
`date1904`** (1900 system applies); `<sheets>` holds exactly one sheet, named
`Export`, addressed only as `r:id="rId1"`.

### 1.2 Findings

**F-A — Identity lives in `Description`.** Brand and Model are blank. Both are
required `String` today, so **the client's own sample row cannot be imported at
all** as the schema stands.

**F-B — Two date encodings in one file.** Purchase Date is a numeric serial;
Date Created is a US-format string. The serial is unambiguous; the string is not.

**F-C — The tag is zero-padded alphanumeric** (`KE001771`), and AM-02 already
recorded the trap where a blank tag lands as `''`, occupies the unique index, and
makes the _second_ blank-tagged row report a phantom duplicate
(`src/lib/asset-admin.integration.test.ts:458`).

**F-D — The row contradicts itself.** `Status` is `Available` (nobody holds it)
while `Assigned to` names a person. The legacy register retains the last assignee after
check-in: it is a _history_ field there and a _state_ field here.

**F-E — Cells are sparse.** Columns E, G, I and N have **no `<c>` element**.
Index-based reads misalign. Columns are resolved by header name (`C14`).

**F-F — Cost is text in a money column, styled as dollars.** `t="s"` with numeric
format `\$0.00`, in a Kenyan organisation, against a `purchasePrice` column that
records no currency. **The currency is unconfirmed and must be got in writing**
(`C13`).

**F-G — The file carries PII outside its cells.** `docProps/core.xml` holds
`<cp:lastModifiedBy>Kiana, Brian Mureithi (IITA)</cp:lastModifiedBy>` — a third
real name, fuller than the one in the `Created by` cell — and `xl/workbook.xml`
holds `absPath url="C:\Users\BMK\Downloads\"`, the exporter's Windows username.
Both sit in entries the parser never reads. That safety is made an **invariant**,
not an accident (`C38`).

---

## 2. Field mapping

| #   | Export column  | Destination                                                        |
| --- | -------------- | ------------------------------------------------------------------ |
| 1   | Asset Tag ID   | `Asset.tag` — idempotency key; blank → quarantine                  |
| 2   | Description    | `Asset.description` **(new)** — identity line                      |
| 3   | Purchased from | `Asset.supplier`                                                   |
| 4   | Purchase Date  | `Asset.purchasedAt` — serial only, strings quarantined             |
| 5   | Brand          | `Asset.make` → **nullable**                                        |
| 6   | Cost           | `Asset.purchasePrice` — strict decimal regex, currency unconfirmed |
| 7   | Model          | `Asset.model` → **nullable**                                       |
| 8   | Serial No      | `Asset.serial`                                                     |
| 9   | PID            | **no column** — meaning unknown (`C4`, `C31`)                      |
| 10  | Asset Type     | **no column** — meaning unknown (`C4`, `C31`)                      |
| 11  | City/Station   | **report only**, unless the census earns it a column (`C17`)       |
| 12  | CC             | `Asset.costCentre` **(new)**                                       |
| 13  | P.O Number     | `Asset.poNumber` **(new)**                                         |
| 14  | Site           | _(blank in sample)_ — census decides (`C17`)                       |
| 15  | Location       | **`Site.name`** (`C17`)                                            |
| 16  | Category       | `Category` (reference)                                             |
| 17  | Department     | `Asset.department` **(new)**                                       |
| 18  | Assigned to    | `Person` + `Assignment` — §5                                       |
| 19  | Date Created   | **not imported**                                                   |
| 20  | Created by     | **not imported anywhere** (`C7`)                                   |
| 21  | Status         | `Asset.status` — §4.1                                              |

Five new nullable `Asset` columns: `description`, `poNumber`, `costCentre`,
`department`, `location`.

**Why PID and Asset Type get no column.** Nobody can state what `CE` means. A
column named `assetType` holding an unexplained code is worse than no column: it
gets rendered, exported, and depended upon. The first full import hands us the
real distribution, and `C31` decides then.

**Why `Created by` is not imported at all** — not even to `ImportBatch.report`.
Its only purpose is "who typed this row in 2024"; nobody will query it. Putting
it in `report` would create a **new PII container** in a table with no role gate,
no retention policy, and this codebase's blanket no-delete rule — a
_code-written_ copy of staff names, strictly worse than the operator-typed
`AssetEvent.notes` risk it was meant to dodge. The dry-run names the column as
deliberately skipped, with a distinct-value **count** and no values.

---

## 3. `make` and `model` both become nullable (F-A)

Deriving `make` from `Description` works for `HP …` and **invents a
manufacturer** for everything else, unrecoverably. Failing rows with no Brand
quarantines most of ~400 and the cutover cannot happen. Both columns become
`String?` in one migration — `model` is blank in the same row with the identical
problem.

Display precedence is stated **once, centrally** (`C3`): `make + model` → else
`description` → else `tag`. The register's own creation form still requires make
and model; the nullability serves imported history, not new data entry.

**A masking effect moves rather than disappearing** (`C26`). `asset-search.ts`'s
`if (contains === "") return {}` guard is currently un-falsifiable by result set
because `make`/`model` are non-nullable, so `ILIKE '%%'` matches everything
anyway. Making them nullable does not expose it — the masking moves to
`category.name`, which is non-nullable behind a required FK. **The correct action
is to fix the comment, not to write a test claiming to red-prove the guard.** A
fabricated red-proof here would be exactly the unfalsifiable-guard failure this
project has already hit repeatedly.

---

## 4. Vocabulary

### 4.1 Status — total lookup, fail closed, **quarantine the row**

| Source (case/space-insensitive)           | →              |
| ----------------------------------------- | -------------- |
| `Available`                               | `IN_STOCK`     |
| `Checked Out`                             | `ASSIGNED`     |
| `Under Repair`, `In Repair`               | `IN_REPAIR`    |
| `Disposed`, `Retired`, `Sold`             | `RETIRED`      |
| `On Order`                                | `ON_ORDER`     |
| **anything else, including empty/absent** | **quarantine** |

Only the first line is evidence.

A **total `Record<string, AssetStatus>`** with an explicit `undefined →
quarantine`, never a `switch` with a permissive default (`C15`).

**Quarantine the row, not the run.** With ~400 rows, fail-fast means one `Lost`
row blocks 399, and the operator's remedy is editing the spreadsheet — which
destroys the source↔register correspondence the reconciliation depends on.

**`Lost`/`Missing`/`Stolen` must not map to `RETIRED`.** Retired means disposed
of deliberately; a stolen laptop filed as retired stops being chased. **No new
enum member in this story** — a sixth `AssetStatus` touches `ASSET_TRANSITIONS`
(5×5→6×6), `tagRequiredFor`, the CHECK exemptions, every status filter, and a
chip palette already at its CVD limit at five hues.

### 4.2 Category and Site — the second one-way door

Reference rows are `@unique`, renamed-never-removed, and **a rename cannot
merge**. So creation is gated on a human, not on cleverness (`C16`): the dry-run
emits a **distinct-value census**, case-insensitively matched against existing
rows, and creation happens only after operator sign-off.

**Site comes from `Location`, not `City/Station`** (`C17`). My earlier draft had
`City/Station → Site`, which would have named the client's permanent site rows
`KE02` and discarded `IITA Nairobi ICIPE Office` — the only human-readable place
in the row. `City/Station` goes to the report unless the full census shows a
stable code worth its own column.

### 4.3 Dates (F-B)

The **numeric serial is canonical** — epoch 1899-12-30, verified: 45177 →
2023-09-08 (`C12`). Any **string** date is quarantined, never locale-guessed.

This is also why the XLSX is read directly rather than via CSV: Save-As-CSV
renders serial 45177 through its number format as `09/08/2023`, which is 8
September and reads as 9 August to everyone in Nairobi. The serial has no such
ambiguity.

`date1904` is asserted absent/false and **the whole file is rejected if set**
(`C36`). A Mac-produced re-export shifts every date by 1462 days — four years —
silently.

---

## 5. The person path

### 5.1 `Person.email` becomes `String? @unique`

Defensible independently of the import: **a holder is not necessarily a system
user.** Login identity is `User.email`, which stays required and unique.
`assertPersonAssignable` already documents that a person with no `User` is fully
assignable, and `Person.user` is already optional — the schema agrees everywhere
else.

**No synthesized address, ever** — no placeholder, no `.invalid` (`C2`). It
fabricates a personal datum, and two same-named people either collide on a
confusing P2002 or **merge into one person**.

Blank email lands as `NULL`, never `''` — the same unique-index trap as F-C.

### 5.2 Exact-unique-or-nothing (`C8`)

Case-folded, whitespace-collapsed match against `Person.name`:

- **1 match** → link.
- **0 matches** → create a stub (`email: null`, `employeeRef: null`).
- **2+ matches** → **quarantine.** No fuzzy matching, no first-match.

A wrong match attributes someone else's laptop to a named individual — a
data-protection error that is invisible afterwards, because the result is
indistinguishable from a correct import. And because `Assignment` is write-once,
`AssetEvent` append-only and nothing is ever deleted, **it can only be papered
over with a fabricated return.** That is the first one-way door.

**Nullable email removes the dedupe key for exactly the rows the import
creates**, so the resolution list gets human sign-off (`C9`): every assignee
listed as `MATCHED <employeeRef|—>` or `WILL CREATE`, signed by the IT admin
before `--commit`, as a named line on the cutover checklist.

### 5.3 The Status/Assigned-to conflict (F-D)

- Status → `ASSIGNED` **and** a name → import `ASSIGNED`, open an `Assignment`.
- Status → `ASSIGNED` **and no name** → quarantine. An assigned asset with no
  holder is the invariant the register exists to prevent.
- Status → anything else **and** a name → import at the mapped status, **do not**
  open an assignment, report the dropped holder under its own reason.

The sample row is the third case. Carrying the name over would fabricate a
current assignment out of a history field, putting a named person on the hook for
kit they returned.

> **Open for Kelvin:** if the client confirms `Assigned to` is only ever
> populated for currently-held assets, this flips and the sample row imports as
> `ASSIGNED`. One predicate; written the conservative way round because that is
> the recoverable direction.

---

## 6. The write path

### 6.1 `importAssetWithEvent` (`C19`)

Writes **exactly one** `AssetEvent`: `type: IMPORTED`, `fromStatus: null`,
`toStatus` the terminal status, `assignmentId` set when the row opens an
assignment, `actorId: null` (the established "system action" convention — no
impersonated admin).

It must **not** call `createAssetWithEvent` (whose `INITIAL_ASSET_STATUSES`
cannot express a legacy `ASSIGNED`/`IN_REPAIR`/`RETIRED` row), **not**
`transitionAssetStatus` (create-then-transition fabricates `STATUS_CHANGED`
events for transitions that never happened), **not** `assignAsset` (fabricates an
`ASSIGNED` event dated today for a two-year-old handover), and **not** reuse
`eventTypeFor`.

Assignments are inserted via the existing `createOpenAssignmentTx(tx, {…,
checkedOutAt })`, whose `checkedOutAt` branch has **no production caller today** —
a known no-coverage gap in issue #12 with AM-04 named as its owner. **This story
closes it.**

### 6.2 Idempotency — insert-only (`C20`)

`tag` is the key. Existing tag → **skipped**. Differing non-key fields →
reported as **CONFLICT** (field **names** only — `description` may contain a
name) and **not written**. **No `UPDATED` events, ever**: a re-run must not
silently revert the twenty descriptions an admin fixed by hand between runs,
each with an `UPDATED` event claiming they made the change.

A blank tag has no key and is **always quarantined** (F-C).

### 6.3 Transactions and concurrency (`C22`)

**One transaction per row** — asset + `IMPORTED` event + assignment atomic per
row, preserving the same-transaction audit rule. Partial failure leaves N
imported and the rest not, which is safe precisely because insert-only
idempotency lets a re-run finish the job. Chunking buys nothing over per-row.

**Unpooled connection + `pg_advisory_lock` for the run**, rows sorted by tag.
Note the reason `AM-04-CF-A`'s deterministic ordering matters has **changed**:
with per-row transactions the asset locks are held briefly, so the deadlock
window shrinks. The binding hazard is now **duplicate stub persons** — email is
nullable, so `@unique` no longer dedupes them and two concurrent runs create two
Lindahs. Sorting does not fix that; **the advisory lock does.**

(Session-scoped advisory locks on a _pooled_ connection is a known hazard — hence
unpooled.)

---

## 7. Parsing — `fflate` + a purpose-built reader

Rejected on surface area: npm's `xlsx` (SheetJS) is stale at **0.18.5**, with the
CVE-2023-30533 and CVE-2024-22363 fixes shipped only to SheetJS's own CDN and
never to npm; `exceljs` unpacks to **21.8 MB** to evaluate formulas, styles,
images and defined names we never read.

Chosen: `fflate` (8 KB runtime) plus ~100 lines reading **exactly four** entries —
`xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`, and the
worksheet the rels resolve to. No formula evaluation, no macros, no styles.

**Hand-rolled scanning, never a general XML parser** (`C40`) — that is part of why
this is safe (billion-laughs / XXE). Swapping one in later needs a new consult.

### 7.1 Guards

| Guard            | Rule                                                                                       | Condition |
| ---------------- | ------------------------------------------------------------------------------------------ | --------- |
| Sheet target     | resolved via `xl/_rels/workbook.xml.rels`, **not hardcoded**; assert exactly one `<sheet>` | `C35`     |
| `date1904`       | asserted absent/false; whole file rejected if set                                          | `C36`     |
| Cell types       | allowlist `t="s"` + bare numeric; **fail closed** on `inlineStr`, `str`, `b`, `e`          | `C37`     |
| Columns          | resolved **by header name**, never by index (F-E)                                          | `C14`     |
| Package metadata | `docProps/*`, `absPath` never read, surfaced or persisted (F-G)                            | `C38`     |
| Cost             | strict `^\d+(\.\d{1,2})?$` after trim — **never** `Number()`/`parseFloat`                  | `C13`     |

`parseFloat("1,229.81")` returns `1` — a silent 1000× error in a finance field.

Treating an unhandled cell type as empty **silently drops data**, which is the
one thing the AC forbids.

### 7.2 Zip caps (`C34`), derived from the real file

Measured: 8,245 bytes compressed → 37,023 uncompressed; 4.5× overall, 7.4× worst
entry; 10 entries. A 400-row export scales `sheet1` ~200×: roughly 1 MB
compressed / 5 MB uncompressed.

| Cap                    | Value                                      |
| ---------------------- | ------------------------------------------ |
| Input file             | 10 MB                                      |
| Total decompressed     | 64 MB                                      |
| Per-entry decompressed | 64 MB                                      |
| Max compression ratio  | 100:1 (measured 4.5×; bombs are 1000:1+)   |
| Max entry count        | 64 (real file: 10)                         |
| Entries inflated       | exactly the four named, exact-string match |

**The cap that actually matters:** with `unzipSync` a size check is a
_post-mortem_ — the allocation already happened. And the entry allowlist does not
save you, because an attacker controlling the file simply names their bomb
`xl/worksheets/sheet1.xml`; the allowlist is a second, weaker layer.

**TWO controls, and both are load-bearing.** `AM-04-C34` originally read "a
streaming inflate with a hard byte-count abort is required, not optional". That
is necessary but not sufficient, and the amended condition says so — see §9.2 for
the measurement. fflate's `Inflate` materialises the whole of a push before
`ondata` fires, so the abort alone cannot prevent the allocation it is looking
at:

- **The push size bounds ONE call.** 16 KiB in, ~16.5 MB out worst case, given
  deflate's ~1032:1 ceiling. This is what makes the abort _timely_.
- **The cumulative byte count bounds the TOTAL.** 640 pushes of a 10 MB file
  still reach ~10 GB without it. This is what makes the total _bounded_.

Neither substitutes for the other, and the sentence "the push size is what bounds
it, not the abort" is true of peak-per-push and false of cumulative — it is
precisely the sentence that would get someone to delete the abort as redundant.
Deleting either must fail a test: the push constant is guarded by the
shipped-default bomb test, the abort by the lowered-push variant.

**Path traversal, stated positively:** the parser never writes an entry to disk
and never resolves an entry name as a filesystem path. Exact-string allowlist,
not a path join — structural, not a sanitiser.

---

## 8. Surface — CLI, settled

**Decision (Kelvin, 2026-08-07): CLI only, as ruled.** The design first recorded
a preference for an ADMIN_IT web upload page; the advisor ruled against it and
the ruling is accepted in full. No overrule to record, and `AM-04-C10`'s F5
branch closes.

The advisor credits the `fflate` choice as defusing the _dependency_ leg of its
argument. The leg that survives is **architectural, not security**: `--commit`
needs the unpooled connection and a session advisory lock (§6.3), runs ~400
sequential row transactions, and does not fit a Vercel function's execution
shape. A one-time cutover does not justify a permanent endpoint.

CLI dissolves the whole F5 sub-question list by construction: no upload, no size
limit, no server-side dry-run state, and authorisation is possession of
`DATABASE_URL` — the same boundary `scripts/seed-staff.ts` and
`scripts/seed-reference.ts` already sit behind, with `actorId: null` per the
established "system action (seed script)" convention rather than an impersonated
admin.

The §7.2 zip caps still apply. They are not upload defences — they are
malformed-file defences, and a file mailed to an engineer is no more trustworthy
than one posted to an endpoint.

**Consequence for the sign-off gates.** `C9` (assignee resolution) and `C16`
(category/site census) need a human to read a list and sign it. With no web
screen, the dry-run writes a **report file** the IT admin reads and signs — the
artefact the cutover checklist already calls for. That is a stronger record than
a screen: it is attachable to the sign-off.

**Not built here, and named so it is not silently lost:** the review screens the
web option would have given (`C9`/`C16` in the browser). If the client wants them
later they are a read-only surface over `ImportBatch`, and `AM-04-C6`'s
no-personal-data rule on the persisted report is what makes that surface cheap —
which is the other reason to hold that line now.

### 8.1 How "the committed data is the previewed data" is proved (`C21`)

`--commit` takes `--batch=<dry-run id>`, re-parses the file, recomputes **both**
the source-file SHA-256 and a normalised parsed-row hash, and refuses on any
difference. Zero server-side state, and the property is provable rather than
asserted.

---

## 9. T3 conditions — `AM-04-C1`…`C40`

Ruling: **PASS WITH CONDITIONS**. Every condition is answered one by one in the
PR body per CLAUDE.md. Blockers unless marked `[F]`.

**Schema & data** — C2 nullable email, no synthesized address · C3 make/model
nullable, central display precedence · C4 five new columns, none for PID/Asset
Type · C5 `ImportBatch` declared a bounded state row · C11 DPA note gains the
data-subject-widening paragraph.

**PII** — C6 `report` contains no name/email/employeeRef/verbatim row echo · C7
`Created by` not imported · C8 exact-unique-or-nothing · C9 operator sign-off on
the resolution list · C38 package metadata never read.

**Parsing** — C10 XLSX direct via `fflate` · C12 serial canonical, strings
quarantined · C13 strict decimal, **currency unconfirmed** · C14 by header name ·
C15 total status map · C34 zip caps + streaming abort · C35 rels-resolved sheet ·
C36 `date1904` · C37 cell-type allowlist · C40 no general XML parser.

**Write path** — C16 reference census + sign-off · C17 Site from Location · C19
exactly one `IMPORTED` event · C20 insert-only · C21 hash binding · C22 per-row
transactions, unpooled, advisory lock · C23 `rowsOk + rowsFailed === source row
count` · C24 `AM-04-CF-B` scoped reconciliation · C25 `description` in
`assetSearchWhere` + positive control · C26 fix the comment, don't fake a
red-proof.

**Process** — C1 repo-wide ignore globs ✅ _(done, `49f52bd`)_ · C18 full export
before implementation · C27 `pg_dump` restored once into a Neon branch before
production `--commit` · C28 CLAUDE.md gains the durable facts · C33 add the
import module to `stryker.config.mjs` in this PR.

**Follow-ups** — C29 stubs lose the assign picker's disambiguator · C30 a stub
Person can never gain a User; a later email match creates a second Person ·
C31 PID/Asset Type from the census · C32 register pagination.

### 9.1 Red-proofs

Every guard below is proven by deleting the named production line and watching a
named test fail.

| Guard                             | Delete to prove                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ambiguous name never auto-matched | the `matches.length === 1` check → two same-named Persons                                                                                                                                                     |
| Report carries no PII             | the redaction → assert `JSON.stringify(report)` lacks `"Jane Holder"`                                                                                                                                         |
| Unknown status never defaulted    | replace with a fallback to `IN_STOCK` → **both** the unrecognised **and** the empty/absent tests must go red                                                                                                  |
| Blank tag quarantined             | the tag normalisation → `""`, `"   "` and an absent column must **all three** go red                                                                                                                          |
| Exactly one event per import      | the assertion — **exact count**, not a floor                                                                                                                                                                  |
| Insert-only idempotency           | the existing-tag skip → re-run asset-count goes red                                                                                                                                                           |
| Hash binding                      | the comparison → mutate one cell between dry-run and commit                                                                                                                                                   |
| Advisory lock                     | the lock → two concurrent runs behind a barrier → two stub Persons                                                                                                                                            |
| Zip streaming abort               | **two-variant bomb fixture**: named `xl/media/bomb.bin` proves the allowlist; named `xl/worksheets/sheet1.xml` proves the abort. A filter that inflates-then-discards passes the first and OOMs on the second |
| Sheet resolution                  | the single-`<sheet>` assertion → two-sheet fixture imports the wrong sheet                                                                                                                                    |
| `date1904`                        | the check → dates land 1462 days out                                                                                                                                                                          |
| Cell-type allowlist               | the default-throw → an `inlineStr` value silently becomes empty                                                                                                                                               |
| `description` searchable          | the description branch → "findable with null make/model" goes red                                                                                                                                             |
| Reconciliation totals             | **guard the premise**: fixture needs `sourceRowCount > 0` **and** `rowsFailed > 0`, or `0 + 0 === 0` passes vacuously                                                                                         |

---

## 9.2 Two things found by running it, that testing could not find

Recorded because both are the kind of defect a green suite actively conceals.

**`server-only` stops the CLI from starting at all.** `import-run.ts`,
`asset-import.ts` and `asset-admin.ts` behind them begin with
`import "server-only"`, whose package exports resolve to a throwing module on
any condition except `react-server`. Next.js supplies that condition; a plain
Node process does not. **The test suite cannot catch this**: vitest aliases
`server-only` to `test/server-only-stub.ts`, so every unit and integration test
exercises those modules with the guard already removed. 600 green tests, and
`pnpm db:import` threw before reading a row. Fixed by passing
`--conditions=react-server` in the package script — not by dropping the marker,
which is what keeps these modules out of a client bundle.

**fflate's inflate is not chunk-abortable the way the ruling assumed.**
`AM-04-C34` requires "a streaming inflate with a hard byte-count abort", on the
reasoning that a size check after `unzipSync` is a post-mortem. Correct, but
incomplete: fflate's `Inflate` produces _all_ output for a push inside `inflt()`
and only then calls `ondata`, so aborting inside `ondata` cannot prevent the
allocation it is looking at — only the next one. Pushing the whole archive in
one call therefore allocates a 1 GB entry in full before any abort can fire.

**Mutation testing structurally could not have found this**, which is why the
hand-written shipped-default test is not redundant with a 99.73% score. Stryker
generates exactly one mutant for `pushChunkBytes: 16 * 1024` — the arithmetic
mutator's `16 / 1024` — and kills it. That mutation makes the chunk _smaller_,
which is the safe direction. **Nothing in its mutator set makes a constant
bigger**, and bigger is the only direction that matters here. The amended
`AM-04-C34` therefore asks for a mutation automated tooling does not generate,
the same shape as the recorded fact that shell scripts and workflow files sit
outside Stryker's reach entirely. A high mutation score is not evidence that a
threshold constant is guarded.

What actually bounds it is **how much compressed input a single push carries**.
Deflate's maximum expansion is ~1032:1; measured against fflate 0.8.3, a
4,096-byte push of a zeros bomb produced 4,132,129 bytes (1009×). At a 16 KiB
push the worst case is ~16.5 MB regardless of the entry's real size. The
condition is met, but by bounding the push rather than by trusting the abort.

---

## 10. Source-file handling

The export lives **outside the repo**, is deleted from the working tree at
cutover, and the client's own copy is the retained original. `.gitignore` now
ignores `*.xlsx`/`*.xls`/`*.csv` repo-wide with `!*.example.csv`, verified by a
`git check-ignore` matrix; `git log --all -- '*.xlsx' '*.xls'` is empty, so
nothing ever entered history and there is nothing to purge.

**Fixtures are synthetic** and must reproduce the real file's awkward _shapes_ or
they prove nothing (`C39`): sparse cells with no `<c>` element, Cost as a shared
string in a currency-styled cell, Purchase Date as a bare serial, ~187
styled-but-valueless rows, and a header row whose column order is not assumed —
plus the cases the real file has no example of: an ambiguous name, an unknown
status, a duplicate tag.

---

## 11. Out of scope, named

Person admin screen (AM-03-CF-1) · register pagination (C32 — and this story is
what makes it real) · finance export (AM-05) · re-import as update · a `LOST`
status (§4.1) · `PID`/`Asset Type` columns (C31).
