# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, confirmed 2026-08-30.

**In-app — operators.** Four roles, enforced server-side on every mutating path:

| Role          | Job                                                                                 |
| ------------- | ----------------------------------------------------------------------------------- |
| `ADMIN_IT`    | Issues and recovers devices, runs the repair loop, provisions users                 |
| `PROCUREMENT` | Records orders; tags assets on delivery                                             |
| `FINANCE`     | Consumes purchase and value reporting                                               |
| `STAFF_RO`    | Read-only; in practice answers one question about themselves — "what am I holding?" |

The shape is a handful of active writers against a large read-only majority, not a
balanced user base. Writers work in bursts around deliveries, new starters, and
repairs; readers arrive once with a single question.

**At the door — adopters.** People evaluating the project: self-hosters who will
fork and run their own instance, and prospective clients considering a hosted
one. **This audience has no surface today** — the README is the entire front
door.

**Design reference case (not a live deployment).** ~70 staff, two sites plus
field workers, ~400 individually tagged assets, an organisation in Kenya. This is
the scale and the workflow the product was fitted to, and it is retained as a
design constraint — not as a deployment, a user, or a reference.

**Real usage scene (confirmed).** Field workers on phones over patchy mobile data.
This is the actual scene, not a hypothetical — it binds payload weight, touch
targets, and offline behaviour.

## Product Purpose

A self-hostable IT asset register that answers _"who has which laptop, and since
when?"_ — and can still answer it two years later. It tracks individually tagged
kit through the full lifecycle: order → delivery and tagging → assignment →
repair loop → retirement, with every transition written as an append-only event.

Success is **adoption**: forks running in the wild, and hosted instances for
paying clients. The register was originally built to replace a subscription SaaS
register on a deadline; that deadline no longer applies, and the migration path
it produced (`pnpm db:import`) is now a general on-ramp rather than a one-off.

## Positioning

The claim a neighbouring register could not truthfully copy: **the audit trail is
correct by construction, not by discipline.**

- **Nothing is ever deleted.** `RETIRED` is an asset's delete, `deactivatedAt` is a
  user's; categories and sites are renamed, never removed. Corrections are new
  events, never rewrites.
- **No personal data in event tables.** The person link is a join
  (`AssetEvent.assignmentId` → `Assignment.personId`), exactly one copy — so a
  data-protection erasure request is honourable rather than structurally
  impossible.
- **Person-field visibility lives in one function**, not scattered across queries;
  `STAFF_RO` is not shown holder data because it is _not fetched_ for that viewer.
- **The lifecycle is the client's, not a vendor's** — a repair loop as a first-class
  state, tag-on-delivery (records exist untagged while on order), and the
  operator's own numeric tag scheme.

Snipe-IT was evaluated at intake and set aside: ownable and API-capable, but a
large PHP application whose generic model needs configuration debt to express a
repair-loop-centric, tag-on-delivery workflow.

## Operating Context

- **A typical operator day:** tag a delivered laptop against a purchase, assign it
  to a new starter, book a faulty phone into repair, return a repaired desktop to
  stock, answer "who has asset 0231?"
- **Tags are typed or searched, never scanned.** Barcode/camera scanning is
  deliberately out of scope — the operator controls the numbering scheme.
- **Migration is a CLI, not an upload.** `pnpm db:import` reads a spreadsheet
  export: dry run produces a row-level report, a human signs off, then `--commit`
  writes. There is deliberately no upload endpoint.
- **Sign-in is a magic link with no open signup.** Users are provisioned by an
  admin; an unknown email fails indistinguishably from any other rejection.
- **Deployment:** Vercel serverless (`fra1`) + Neon Postgres (`eu-central-1`),
  dynamic SSR throughout. Live instance: https://asset-mgt-ten.vercel.app
- **Kenya Data Protection Act 2019 shaped the data model** and still does:
  `Person.employeeRef` and never a national ID; cross-border transfer note at
  `docs/DPA-TRANSFER-NOTE.md`.

## Capabilities and Constraints

**Built and running.** Asset register with the five-state lifecycle
(`ON_ORDER`, `IN_STOCK`, `ASSIGNED`, `IN_REPAIR`, `RETIRED`); assignment and
return with condition notes; per-asset and per-person history; four-role
authorisation; magic-link auth; spreadsheet import with dry-run and sign-off;
app shell with left rail, light/dark theming, responsive card-stack tables;
register search (asset attributes only) and pagination; viewer-timezone
timestamps.

**Specified but not built.** Reports and CSV/finance export (AM-05 — no export
route exists). PWA installability, offline reads, offline indicator (AM-06 —
`public/` is empty; no manifest, no service worker). Dashboard: counts by status
and site, in-repair and awaiting-tag lists (AM-07 — search and pagination
shipped, the dashboard did not).

**Hard constraints that outlive any redesign.**

- Dynamic SSR only. Never `output: 'export'`; the PWA is a manifest and service
  worker over the dynamic app.
- `AssetEvent` and `UserEvent` are append-only. No update, no delete, ever.
- `requireRole(...)` is the first statement of every mutating action and route
  handler. Middleware authenticates; it never authorises. Roles come from the
  database, never from the JWT.
- `AssetEvent.notes` is operator-typed free text visible to all four roles,
  including `STAFF_RO`. It is deliberately **not searchable**, and the register's
  `?q=` searches no person data for any role.
- A tag is mandatory from delivery onward, enforced by a database CHECK
  constraint. `ON_ORDER` and `RETIRED` are exempt.
- No national-ID column anywhere.

**Open decision — multi-tenancy (confirmed direction, unresolved design).** A
hosted multi-tenant SaaS is the intended commercial shape (confirmed
2026-08-30). This **contradicts the current codebase and `CLAUDE.md`**, which
scope the product to a single organisation, and it touches authorisation,
the data model, and the append-only invariants. It needs its own ADR and a
Tier 3 advisor review before any code moves. Until then, the single-organisation
constraints above stand as written.

**Settled — the public demo is a separate deployment with a separate database**
(T3 advisor ruling, 2026-08-30, `docs/features/AM-11/ADVISOR-RULING.md`). A demo
needs periodic reset and this codebase forbids deletion in code and in SQL, so
one database cannot hold both a resettable demo and an audit trail that is never
deleted. A demo branch inside `requireRole` is also forbidden: it would put a
bypass in the most load-bearing primitive in the repo.

**Open — not established, do not invent.** Pricing or commercial terms for hosted
instances; support or SLA commitments; a public roadmap; the exact accessibility
conformance level if a client or funder later names one.

## Brand Commitments

- **Name:** "Asset Register". Generic and client-neutral by decision, so the
  project reads as forkable infrastructure rather than one organisation's tool.
- **No client name, logo, or reference anywhere**, in the repo or in any
  deployment. Prior client references were deliberately scrubbed when the repo
  went public (2026-08-15); do not reintroduce them.
- **No App Artery branding in the product** either — the studio is the author, not
  the brand on the page.
- **Licence: AGPL-3.0** (confirmed 2026-08-30, `LICENSE` written the same day —
  verbatim FSF text). Forks and self-hosting are free; a publicly hosted
  modified version must share its changes. Sole copyright holder, so commercial
  dual-licensing stays open. AGPL section 13 obliges a network-facing modified
  version to offer users its source; the landing page's footer Source link is
  the mechanism, and forks should keep it.
- The README is a simple public-facing page and must stay that way; runbooks live
  in `docs/RUNBOOK.md`.

## Evidence on Hand

- **A real, working deployment** at https://asset-mgt-ten.vercel.app — currently
  three test assets, signed in as IT admin.
- **A genuinely thorough documentation trail** — the strongest adoption asset the
  project has: `docs/DESIGN.md`, `docs/DESIGN-SYSTEM.md`,
  `docs/adr/ADR-001` (Vercel + Neon) and `ADR-002` (build-gated migrations),
  per-feature designs under `docs/features/AM-0*`, four retrospectives under
  `docs/retros/`, `docs/RUNBOOK.md`, `docs/DPA-TRANSFER-NOTE.md`.
- **Real engineering evidence, verified in-repo:** real-Postgres integration
  tests, mutation testing over guard-bearing modules, an env-free build proven in
  CI every run.
- **Local dev data:** ~396 seeded assets, so realistic volume is available to
  design against without any real data.

**Absences that must not be filled with invention.** No users, no customers, no
testimonials, no case study, no adoption numbers, no performance benchmarks, no
uptime record, no pricing. No real client data exists in the repo by rule —
`.gitignore` blocks spreadsheet extensions repo-wide and all fixtures are
synthetic. There is no logo, icon set, or illustration asset of any kind.

## Product Principles

1. **The audit trail is the product.** Every feature is judged by whether the
   register can still be trusted a year later. Convenience never buys a rewrite,
   a delete, or a silently dropped row.
2. **The tag is the handle.** A tag is a sticker on a physical laptop. Looking one
   up is the single most common thing anyone does here, and it must be the
   fastest thing on every surface — especially on a phone.
3. **Privacy is structural, not procedural.** Person data is fetched only for
   viewers entitled to it. Widening that reach is a data-protection decision, not
   a UI decision.
4. **The phone is a real workstation.** Field workers on patchy mobile data are a
   confirmed audience, not a responsive-design afterthought. One-handed lookup,
   assign, and return are the test.
5. **Show the work.** Adoption will be won by visible rigour — the docs, the
   invariants, the tests — not by claims. The front door should demonstrate,
   never assert.

## Accessibility & Inclusion

- **A conformance standard is required** (confirmed 2026-08-30). Working target:
  **WCAG 2.2 AA**. Update this line if a client or funder names a different level.
- **Colour is never the sole carrier of meaning.** The five status states carry a
  text label plus a dot whose fill differs by state, because the status hues fail
  colour-vision-deficiency validation when used as adjacent fills.
- **English only.** No localisation is needed now or planned.
- **Assume a constrained device on a poor connection**, not a desk with fibre.
