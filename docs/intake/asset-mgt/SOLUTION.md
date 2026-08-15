# Solution Sketch — Internal IT Asset Register (`asset-mgt`)

- **Date:** 2026-07-24
- **Effort band:** **M**
- **Companion docs:** `DISCOVERY-BRIEF.md` (why), `PRD.md` (what, in order)

## Stack

- **Application:** Next.js 15 (App Router, TypeScript) as a single full-stack app — server actions/route handlers for mutations. A separate NestJS service is _not_ justified at 3 writers / 70 readers doing CRUD and reports; introduce one only if the Oracle integration later demands long-running jobs.
- **Data:** PostgreSQL (Neon) + Prisma.
- **UI:** Tailwind CSS v4 + shadcn/ui; mobile-first layouts for the flows field workers touch (lookup, assign, return).
- **Auth:** Auth.js — provider depends on the client's IdP (open assumption 4 in the brief): org SSO if Google Workspace/M365 exists, otherwise email magic-link via Resend (first-class Auth.js provider). Role claims: `ADMIN_IT`, `PROCUREMENT`, `FINANCE`, `STAFF_RO`.
- **PWA:** web manifest + service worker; installable on Android/iOS; cached reads only — no offline writes at MVP.
- **Infra (Vercel):** Vercel hosts the Next.js app natively — no build adapter, no CDN config. Neon Postgres via the Vercel Marketplace (`vercel integration add neon`): scale-to-zero with ~500ms resume (vs Aurora Serverless v2's ~15s wake), pooled connection string, env vars auto-injected. Resend for auth email. Function region pinned to an EU region (e.g. `fra1`) colocated with the Neon region — Neon offers no Africa region, so af-south-1-style proximity is off the table; Kenya DPA transfer safeguards documented at scaffold. Terraform drops out — a named deviation from the studio spine (brief §7); Vercel and Neon Terraform providers exist if the studio later enforces the spine.

## Data shape

```
Asset       id, tag (unique, NULLABLE until delivery), categoryId, make, model, serial,
            purchasedAt, purchasePrice, supplier, warrantyUntil, status, condition, siteId
Person      id, name, email, employeeRef   ← employee number, NOT national ID (brief §7.3)
Assignment  id, assetId, personId, checkedOutAt, returnedAt, conditionNotes
AssetEvent  id, assetId, type, fromStatus, toStatus, actorId, notes, at   ← append-only audit trail
Category    id, name                       ← "any IT asset": laptops → headphones
Site        id, name
User        id, personId, role
ImportBatch id, source, runAt, dryRun, rowsOk, rowsFailed, report
```

**Lifecycle:** `ON_ORDER → IN_STOCK` (tag assigned at delivery) `↔ ASSIGNED`; `{IN_STOCK, ASSIGNED} → IN_REPAIR → IN_STOCK`; any → `RETIRED`. Client's reality is repair-heavy — most stock is used/in-repair/repaired, hardly ever new — so the repair loop and condition tracking are first-class, not edge cases. All transitions validated and appended to `AssetEvent`.

## Integration points

1. **Legacy register import** — client holds a backup/export; schema unknown until inspected (week 1). Import harness: dry-run with row-level error report, idempotent re-runs, reconciliation against the legacy register's totals.
2. **Finance export** — v1 is a CSV/report export whose columns are agreed with the finance user in week 1. The client's Oracle product is unidentified; direct API integration is post-MVP.
3. **Org IdP** — TBC; determines Auth.js provider.
4. **Resend** — auth email (and post-MVP alerts); free tier is 3,000 emails/month against ~70 staff logins.

## Risky decisions

1. **Hosting: Vercel Hobby's non-commercial-use term.** The build's economics only hold if idle cost is near zero. Vercel Hobby + Neon Free + Resend Free deliver $0/month — but Hobby's terms prohibit commercial use, and an internal tool for a client organisation arguably qualifies. **Risk accepted and named (client decision, 2026-07-28):** run on Hobby. If Vercel objects, the mitigation is Pro at $20/month/seat — which puts run cost at rough parity with the legacy subscription being escaped and reduces the build case to ownership + workflow fit alone. **ADR at scaffold.**
2. **Auth and identity.** Provider choice (SSO vs magic-link) and the decision to store `employeeRef` rather than national ID. Security-touching → **floors at Tier 3, advisor review mandatory** (studio rule).
3. **Finance "integration" as an export contract.** Building against an unidentified Oracle product would be speculation; v1 ships a stable, versioned export whose shape finance signs off. Risk accepted and named in the brief; direct integration is a post-MVP story once the product is identified.

## Cost sanity check

Target run cost: **$0/month** at this usage — Vercel Hobby (free), Neon Free (0.5 GB storage, scale-to-zero; ~400 assets plus audit trail is a few MB), Resend Free (3,000 emails/month). Stronger than the single-digit-dollars AWS shape it replaces, and the number that makes "own it instead of renting it" true rather than rhetorical — contingent on the Hobby ToS risk above. The paid fallback (Vercel Pro $20/month) erodes it to parity; Neon's first paid tier adds ~$5–19/month only if the free tier is outgrown, which this workload will not do.
