# Kenya DPA 2019 — Cross-Border Transfer Note (`asset-mgt`)

- **Date:** 2026-07-28 (written at scaffold, per advisor condition in
  [DESIGN.md](DESIGN.md))
- **Scope:** processing of staff personal data outside Kenya by the internal
  IT asset register

## What personal data is processed

Staff records limited to: **name**, **work email**, and **employee reference
number** (`Person.name`, `Person.email`, `Person.employeeRef`), plus asset
assignment history linking a person to equipment. Deliberately excluded: the
schema has **no national-ID column anywhere** (Discovery Brief §7.3) and must
never gain one; `employeeRef` is the organisation's own employee number.
Auth flow additionally processes the staff email for magic-link delivery.

**Auth activity data.** For staff who also have an account, the register holds
two timestamps about the act of signing in. Neither is a new field and neither
is a new transfer — both are written by the authentication mechanism already
described above — but they are recorded here because they are now **displayed**
rather than merely stored, which is the trigger in "Reviewing this note if
scope changes" below:

- `User.emailVerified` — written by the Auth.js adapter on every successful
  magic-link redemption, so in practice it is the time of that person's **last
  sign-in**.
- `VerificationToken.identifier` **and** `.createdAt` — the address a magic
  link was issued to, and when it was last **issued**. The identifier is the
  personal datum here; a bare timestamp identifies nobody, so both are named.
  Held only for links that have not been redeemed — a redeemed link's row is
  deleted by the adapter. The link **token** itself is never selected: it is
  the bearer credential in the email, and reading it would put a working
  sign-in link for another person into the page.

Both are shown on `/admin/users`, and only there, so an IT admin can tell an
account whose invitation never arrived from one nobody has invited yet.
**Retention:** neither field accumulates a sign-in history, but the two retain
by different mechanisms and only the first is an overwrite:

- `User.emailVerified` is a **single timestamp, overwritten in place** on each
  successful redemption. Only the most recent sign-in survives; earlier ones
  are not recoverable from this column.
- `VerificationToken` holds **one row per unredeemed link**, so **several rows
  may exist for one address at the same time** — the table is unique on
  (`identifier`, `token`), not on `identifier`. A row is deleted when its link
  is redeemed (`@auth/prisma-adapter` `useVerificationToken`). A link that is
  never redeemed leaves its row in place: expiry does not delete it, and no
  pruning job exists, so unredeemed rows persist until deleted deliberately.
  `/admin/users` displays only the newest `createdAt` per address — that is a
  display choice and not a statement about what the table holds.

These rows are also the sign-in throttle's counting basis
(`src/lib/sign-in-policy.ts`), so pruning them is a rate-limit change, not
only a retention one.

Nothing about sign-in activity is written to the append-only `UserEvent`
table, where it would be permanently uncorrectable and unerasable.
Engineering change of 2026-08-02 (issue #11); no legal review is implied.

**Data subjects widen at the legacy register migration (AM-04).** Recorded here
because the trigger clause below fires — **not** because the fields, the
purpose, the location or the processors change. They do not: this is the same
`Person` record, in the same database, for the same purpose. What changes is
**whose**.

Until now every `Person` was provisioned deliberately by an IT admin, so the
population was current staff with accounts. The migration imports the client's
legacy register, and its `Assigned to` column names **everyone who has ever
held equipment** — including **leavers**, contractors, and people who never had
a login and never will. Those records are created by a script from a
spreadsheet rather than by a person typing them, which is precisely why it is
worth stating: nobody reviews them one by one at the moment of creation.

Three consequences follow, and each is a deliberate design decision:

- **Imported holders carry a name only.** `Person.email` became optional in
  this story and imported records leave it null; `employeeRef` is null too, as
  the export has no such column. This is the narrowest record the register can
  hold for someone — a name and what they held — and it is narrower than the
  provisioned-staff record described above. **No email is ever synthesized**
  for them: fabricating a contact address for a leaver would create a personal
  datum the client never held, and it could not be distinguished from a real
  one afterwards.
- **A name is never matched approximately.** Exactly one existing match links;
  none creates a new record; **two or more refuses and the row is quarantined
  for a human**. A wrong match would attribute one person's equipment to
  another, and because `Assignment` is write-once and `AssetEvent` append-only,
  the only available correction is a fabricated return.
- **No name enters an append-only table.** The person link is
  `AssetEvent.assignmentId` → `Assignment.personId` — one copy, joinable — so a
  correction or an erasure request remains honourable. The export's
  `Created by` column, which is a third person's name, is **not imported at
  all**, including into `ImportBatch.report`.

**Retention consequence to flag to the client:** the register will hold records
for former staff for as long as it holds their equipment history, which is the
point of an audit trail and is also a retention question only the client can
answer. Nothing in this codebase deletes; deactivation is a flag. If a
retention period is required for leavers, it needs a deliberate mechanism and
this note should be revisited before one is built.

Engineering change of 2026-08-07 (AM-04, advisor condition C11); no legal
review is implied.

## Where it is processed

| Processor | Role                                       | Location                                 |
| --------- | ------------------------------------------ | ---------------------------------------- |
| Vercel    | Application hosting (serverless functions) | `fra1` — Frankfurt, Germany (EU)         |
| Neon      | Postgres database                          | `eu-central-1` — Frankfurt, Germany (EU) |
| Resend    | Auth email (magic links)                   | United States (email delivery)           |

Storage and processing outside Kenya constitute a **transfer of personal data
outside Kenya** under **sections 48–49 of the Data Protection Act, 2019**.

## Safeguards (s. 48(1)(a), s. 49)

- **Minimisation:** only the three staff fields above are stored; no national
  ID, no financial or special-category personal data.
- **Jurisdiction with appropriate safeguards:** primary storage and compute
  are in Germany, subject to the GDPR — a jurisdiction with data-protection
  law materially equivalent to (and stronger than) the Act's requirements.
- **Processor terms:** Vercel, Neon, and Resend each process under their
  standard data-processing agreements/addenda (GDPR-based, incorporating
  standard contractual clauses); links to each processor's DPA should be
  attached to the client's records at provisioning.
- **Technical measures:** TLS in transit, encryption at rest (Neon), access
  restricted to provisioned, role-scoped accounts (deny-by-default auth);
  independent nightly logical backups retained under the client's GitHub
  organisation.
- **Role-based visibility tiers** — the technical measure implementing the
  minimisation claim above. These fields are not exposed uniformly to every
  authenticated user, and **two different mechanisms enforce that**, which
  matters because only the first is a single chokepoint:

  - The three `Person` fields are decided in one place
    (`personSelectFor(role)`, `src/lib/person-visibility.ts`) and enforced in
    the database `select`, so a role that may not see a field is never sent
    it.
  - The auth-activity fields are enforced at the **route**, by
    `requireRole("ADMIN_IT")` as the first statement of `/admin/users` — the
    only page that reads them. They are not part of `personSelectFor`, which
    governs `Person` PII; these live on `User`/`VerificationToken`, tables the
    other three roles never read at all.

  | Field                          | ADMIN_IT | PROCUREMENT | FINANCE | STAFF_RO |
  | ------------------------------ | -------- | ----------- | ------- | -------- |
  | `Person.name`                  | yes      | yes         | yes     | own only |
  | `Person.employeeRef`           | yes      | yes         | yes     | no       |
  | `Person.email`                 | yes      | no          | no      | no       |
  | `User.emailVerified`           | yes      | no          | no      | no       |
  | `VerificationToken.identifier` | yes      | no          | no      | no       |
  | `VerificationToken.createdAt`  | yes      | no          | no      | no       |

  The **set of stored personal-data fields does not change**, so this is
  **not a new transfer**. It is recorded here because the "Reviewing this
  note if scope changes" clause below is triggered by a change in how the
  data is displayed, and widening any cell in the table triggers it again.
  Engineering change of 2026-07-30; no legal review is implied.

  The auth-activity rows were added 2026-08-02 (issue #11); their enforcement
  mechanism is stated above the table. No role gains sight of a person it
  could not previously identify: ADMIN_IT is already the only role that can
  see every staff email.

- **Necessity:** transfer is necessary for the performance of the tool the
  data subjects' employer operates for its internal asset management
  (s. 48(3) grounds also arguably available; safeguards are relied on
  primarily).

## Client obligations (flag to counsel)

- **ODPC registration:** the client organisation is the **data controller**;
  registration with the Office of the Data Protection Commissioner (and
  keeping it current) is the client's obligation via its own counsel. App
  Artery is not providing legal advice; this note is an engineering record of
  what is processed and where.
- Informing staff (data subjects) of the processing per Part IV of the Act.
- Reviewing this note if scope changes — new PII fields, new processors, or a
  region move — before the change ships.
