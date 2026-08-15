# Discovery Brief — Internal IT Asset Register

- **Slug:** `asset-mgt`
- **Status:** Approved for delivery (go)
- **Date:** 2026-07-24
- **Author:** studio-director (intake, 2 discovery rounds + gap close-out)
- **Client:** Internal organisation, Kenya (~70 staff, 2 sites plus field workers)

## 1. Opportunity

The organisation manages ~400 individually tagged IT assets (and growing) in a legacy SaaS register, which has changed its pricing model, and the organisation wants to be off the platform **before the new pricing takes effect** — a real deadline, exact date not yet confirmed. Beyond cost, the client wants a tool it owns outright, fitted to its actual workflow (repair-heavy lifecycle, its own numeric tag scheme, tag-on-delivery intake), with reporting the finance side can consume.

**Honest framing of the build case:** at ~400 assets the avoided subscription is probably modest (estimated $240–600/year from the vendor's published tiers; exact spend unconfirmed — see §7). The build is justified by ownership, workflow fit, role-based access for three distinct teams, the finance export, and the deadline-driven migration — with cost-avoidance as a secondary benefit, not the business case. Self-hosted Snipe-IT was evaluated and set aside: it is ownable and has an API, but it is a large PHP application whose customisation and operation is ongoing work in a stack the client would be adopting wholesale, and its generic model does not match the client's repair-loop-centric, tag-on-delivery workflow without configuration debt.

## 2. Target user

- **Primary writers (3 active users):** IT admin, procurement, finance — each needs a role-appropriate view. IT issues and recovers devices and manages the repair loop; procurement records orders and deliveries (assets are tagged on delivery); finance consumes purchase/value reporting.
- **Readers:** all ~70 staff, read-only (e.g. "what is assigned to me").
- **Field workers:** real mobile usage — the tool must be installable and usable on a phone (PWA), not merely responsive.

A typical day: tag a delivered laptop against a purchase, assign it to a new starter, book a faulty phone into repair, return a repaired desktop to stock, answer "who has asset 0231?"

## 3. Value proposition

An owned, subscription-free asset register that matches the organisation's exact lifecycle — order → delivery and tagging → assignment → repair loop → retirement — with role-appropriate access for IT, procurement, and finance, a finance-shaped export, and phone-installable access for field workers.

## 4. MVP scope

1. **Asset register** — every asset individually tagged under the client's own numeric tag scheme (tag assigned at delivery, so records can exist untagged while on order); categories covering _any_ IT asset (laptops, phones, desktops, printers, mice, headphones, etc.); purchase data (date, price, supplier, warranty); status lifecycle including the repair loop; site/location.
2. **Assignment** — assign/return to staff with full immutable history; per-asset and per-person views.
3. **Migration and reporting** — import of the client's legacy backup/export; reports and CSV export, including a finance-shaped export.

Cross-cutting: authentication with four roles (IT admin, procurement, finance, staff read-only); PWA installability; production-grade quality (client appetite: MVP, not prototype).

## 5. Out of scope (MVP)

Software licence management; depreciation/accounting; procurement workflows (POs, approvals); helpdesk/ticketing; camera/barcode scanning (tags are typed or searched by number — client controls the numbering); offline writes; **direct Oracle API integration** (deferred until the client identifies the exact Oracle product — v1 is an export finance can consume); multi-tenancy (single organisation).

## 6. Success metrics (6 months)

1. **Legacy register cancelled before its new pricing model applies** — the primary, deadline-driven metric.
2. All ~400 assets migrated with tags, statuses, and assignees intact (verified against the legacy register's totals).
3. Assignment records trusted — no side spreadsheet in use.
4. All three writer teams actively using the tool; staff self-serve their own lookups.

## 7. Constraints, assumptions, and architectural flags

**Constraints**

- Deadline: legacy register pricing change. **Effective date unknown — obtaining it is the first client action (see §10).** Milestone 1 of the PRD is scoped as the minimum cutover path.
- Kenya Data Protection Act 2019 applies: the system stores staff name, email, and an identifier.
- Run cost must be credibly lower than the subscription being escaped — near-zero at idle. This constrains hosting shape (see flags below).
- Studio spine: AWS + Terraform — **deviation accepted (v1.1):** this build ships on Vercel + Neon Postgres, and Terraform is not used. Justified by cost (free scale-to-zero tiers vs AWS's single-digit dollars); recorded as a risky decision in `SOLUTION.md`.

**Open assumptions (client to confirm; none block Milestone 1 start)**

1. Exact legacy register annual cost — still unstated after two direct asks. Estimated $240–600/year from published tiers. Only affects the economics narrative, not the build.
2. Pricing-change effective date — sets the Milestone 1 deadline.
3. **"ID" in staff data:** plausibly a national ID number. Recommendation: store an employee/payroll number instead — a national ID is higher-sensitivity data under the Kenya DPA and appears unnecessary for asset assignment. Treat storing national ID as requiring explicit justification plus advisor review.
4. Organisation identity provider (Google Workspace / Microsoft 365 / none) — determines the auth approach.
5. legacy export schema — client holds a backup; inspect in week 1 to de-risk the import story.

**Architectural flags (≥30% cost/feasibility impact → ADR recommended)**

- **Hosting shape (resolved v1.1):** Vercel + Neon Postgres, both on scale-to-zero free tiers → $0/month at this usage. The always-on-vs-serverless question is closed. The surviving risk is Vercel Hobby's non-commercial-use term — accepted and named in `SOLUTION.md`; mitigation is Pro at $20/month, which is cost parity with the subscription being escaped. ADR at scaffold.
- **Auth approach:** org SSO vs app-local accounts. Security-touching — floors at Tier 3 with mandatory advisor review.
- **Hosting region:** Vercel function region and Neon region colocated in the EU (e.g. `fra1` + Neon `eu-central-1`) — Neon offers no Africa region, so the af-south-1 proximity option is gone. Kenya DPA cross-border transfer safeguards documented at scaffold, exact regions decided there.

## 8. Strategic fit

- **Vertical:** IT / internal tooling (studio vertical 6). Not a priority vertical, but a clean fit for the studio spine.
- **Reusable IP:** an asset-lifecycle registry pattern — role-based access, append-only event history, a CSV import harness with dry-run/idempotency, and a PWA shell — transferable to fleet-log and future logistics/provenance work.
- **Intake filter:** passes, with one caveat recorded — the client's stated driver is escaping a subscription, so scope discipline matters; this is a fixed-appetite M-band engagement, not open-ended T&M.

## 9. Referenced assets

- The legacy register (current system; backup/export in client's hands)
- Snipe-IT (evaluated, not chosen — rationale in §1) — https://snipeitapp.com
- Client's numeric tag scheme (client-owned; tags assigned to assets at delivery)
- Oracle finance system (exact product TBC — export contract to be agreed with the finance user)

## 10. Handoff notes

- **Immediate client actions:** (1) take a fresh, full legacy export _now_ — before any pricing/access change; (2) confirm the pricing-change effective date; (3) confirm whether "ID" means national ID, and whether an employee number can serve instead.
- Delivery bootstraps via `/scaffold` from this brief; stories in `PRD.md`. Milestone 1 (AM-01 → AM-04) is the cutover path and carries the deadline; Milestone 2 rounds out reporting, PWA, and dashboard.
- Solution shape and risky decisions in `SOLUTION.md`. Auth (AM-01) floors at Tier 3 — advisor review is mandatory before it ships.
- Only the studio-director revises this brief. Delivery escalates strategic concerns back; design gaps go to the advisor.

## Changelog

- **2026-07-28 v1.1** — Hosting retargeted: AWS (Lambda + CloudFront + Aurora Serverless v2 + SES, Terraform) → Vercel + Neon Postgres + Resend, no Terraform (studio-spine deviation accepted). Run cost drops to $0/month on free tiers; Vercel Hobby commercial-use ToS risk accepted and named in `SOLUTION.md`. Trigger: client directive to deploy on Vercel with a cheaper database.
- **2026-07-24 v1.0** — Created after two discovery rounds plus gap close-out (trigger: legacy register pricing-model change; jurisdiction: Kenya). Open: legacy register annual cost; pricing-change date; "ID" semantics; org IdP.
