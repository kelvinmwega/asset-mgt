# Scaffold Design — `asset-mgt`

- **Date:** 2026-07-28
- **Status:** Approved (Kelvin, 2026-07-28)
- **Inputs:** Discovery Brief v1.1 · `SOLUTION.md` · `PRD.md` · advisor ruling 2026-07-28 (all five spine deviations approved; conditions folded in below) · [ADR-001](adr/ADR-001-vercel-neon-stack.md)

## Rendering and deployment mode (stated up front)

**Dynamic SSR** Next.js 15 App Router on **Vercel serverless functions pinned to `fra1`**. This is an authenticated CRUD app — _not_ static export. The PWA is a manifest + service worker over the dynamic app, never `output: 'export'`. Every decision below assumes this mode.

## Stack

| Concern  | Choice                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting  | Vercel (Hobby — ToS risk accepted, brief v1.1); prod on `main`, preview per PR                                                                                                                                                                            |
| App      | Next.js 15 App Router, TypeScript strict; mutations via server actions / route handlers only                                                                                                                                                              |
| Database | Neon Postgres `eu-central-1` via Vercel Marketplace, **pooled connection string**                                                                                                                                                                         |
| ORM      | Prisma; lazy-init `globalThis` singleton, plain instance (**never a JS Proxy wrapper**)                                                                                                                                                                   |
| Auth     | Auth.js v5, Resend magic-link (SSO if client IdP materialises); **JWT sessions**; split config — edge-safe `auth.config.ts` for middleware, full `auth.ts` + Prisma adapter for Node                                                                      |
| UI       | Tailwind v4 (CSS-first, no `tailwind.config.ts`) + shadcn/ui — hand-write `components.json` and `lib/utils.ts` (LEARNINGS §Next.js)                                                                                                                       |
| Tests    | Vitest + RTL co-located; real-DB integration via local Docker Postgres + GH Actions service container, `skipIf`-on-`TEST_DATABASE_URL`; pin the same Postgres major as the Neon project                                                                   |
| Tooling  | pnpm (`packageManager` pinned, Node via `engines` + `.nvmrc`), ESLint 9 flat, Prettier, Husky + lint-staged **plus full-repo lint/typecheck in CI** (scope-gap rule), conventional commits                                                                |
| CI       | GitHub Actions: lint, typecheck, full test suite (incl. real-DB) as a **required check under branch protection** on `main`                                                                                                                                |
| IaC      | None (approved deviation). Config as repo artefacts: `vercel.json` pins `fra1`, `.env.example` enumerates every var, `docs/RUNBOOK.md` records manual provisioning (moved out of the README when the repo went public). The runbook substitutes for state |

## Security constraints the skeleton must honour (advisor, T3)

1. **Middleware authenticates; it never authorises.** Deny-by-default matcher (only auth routes + static assets open). Roles are read from the DB inside every mutating action/handler — never trusted from the JWT (also what makes AM-01's "role changeable without redeploy" AC true).
2. **One authorisation chokepoint:** `requireRole(...)` as the first statement of every mutating server action and route handler — greppable, so the AM-01 review can verify coverage mechanically.
3. **No open signup.** Magic links issue only for provisioned emails; unknown email → generic failure. Staff are seeded, not self-registered.
4. `server-only` imports in db/auth/env modules; secrets only in Vercel env vars + gitignored `.env`; `AUTH_SECRET` never committed; `.env.example` placeholders only.
5. Schema: `Person.employeeRef` — **no national-ID column anywhere** (brief §7.3). `AssetEvent` append-only: no update/delete path generated at all; corrections are new events.
6. Actor identity always from the session, role always from the DB; nothing client-supplied is trusted.

## Conditions attached by the advisor

- **Backup independence:** nightly logical backup (GitHub Actions cron `pg_dump` to artefact/client-held storage) must exist **before AM-04 cutover sign-off** — Neon free tier's restore window is short and this becomes the sole register when the legacy register is cancelled.
- **Kenya DPA transfer note** (ss. 48–49) written at scaffold: staff PII processed in the EU is a cross-border transfer. ODPC data-controller registration is the client's obligation — flag to their counsel.
- **Resend sending domain** must be verified before magic links can reach staff inboxes (free-tier default sender only reaches the account owner) — provisioning runbook step.

## Scaffold deliverable (first PR)

App skeleton (routes, auth split-config, Prisma schema + first migration, `requireRole` helper, health page), `vercel.json`, `docker-compose.yml` (Postgres), CI workflow, Husky hooks, `.env.example`, `CLAUDE.md` stub (mode, env vars, deploy target stated explicitly), DPA transfer note, README runbook. Verified: builds, lints, typechecks, tests green in CI. Subsequent stories flow through `/ship` starting with AM-01 (T3 — advisor security review before merge, regardless of this ruling).
