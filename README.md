# asset-mgt

A small, self-hosted IT asset register. It tracks laptops, phones, printers
and other tagged kit from purchase through assignment, repair and retirement —
and answers the question that started the whole project: _who has which
laptop, and since when?_

## What it does

- **Asset lifecycle** — on order → in stock → assigned → in repair → retired,
  with every transition validated and recorded
- **Assignments** — check kit out to a person and back in, with condition notes
- **Append-only history** — every change is an event; nothing is ever deleted
  or rewritten, so the audit trail is trustworthy by construction
- **Roles** — admin, asset manager and read-only views, enforced server-side
- **Magic-link sign-in** — no passwords; users are provisioned by an admin,
  there is no open signup
- **Spreadsheet import** — bring an existing register in from an `.xlsx`
  export: dry run first, human sign-off, then commit

## Stack

Next.js 15 (App Router, dynamic SSR) · Prisma 6 + Postgres 17 · Auth.js v5
(Resend magic links, JWT sessions) · Tailwind v4 + shadcn/ui · Vitest ·
deployed on Vercel + Neon.

## Quickstart

Prereqs: Node 22 (`.nvmrc`), pnpm (version pinned in `package.json`
`packageManager`), Docker.

```sh
pnpm install                 # also runs prisma generate
cp .env.example .env         # fill in real values; never commit .env
docker compose up -d         # Postgres 17 (+ asset_mgt_test database)
pnpm db:migrate              # apply migrations to the dev database
SEED_ADMIN_EMAIL=you@example.com pnpm db:seed
pnpm db:seed:reference       # categories + sites — an asset needs a category
pnpm dev                     # http://localhost:3000
```

Everything is auth-gated (deny-by-default middleware); `/signin` is the only
public page. Sign in with the email you seeded — in dev the magic link needs a
Resend key in `.env`.

## Scripts

| Command                                                   | What it does                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm build` / `pnpm start`                  | Next.js dev / production build / serve                                                               |
| `pnpm lint` / `pnpm typecheck`                            | ESLint (flat config) / `tsc --noEmit`                                                                |
| `pnpm test`                                               | Vitest. Real-DB integration tests run only when `TEST_DATABASE_URL` is set — with it unset they skip |
| `pnpm test:mutation`                                      | Stryker over the guard-bearing modules (requires `TEST_DATABASE_URL`)                                |
| `pnpm db:migrate` / `pnpm db:deploy` / `pnpm db:generate` | Prisma migrate dev / deploy / generate                                                               |
| `pnpm db:seed` / `pnpm db:seed:reference`                 | Seed the first admin + staff, then categories and sites                                              |
| `pnpm db:import <file.xlsx>`                              | Import an existing register. Dry run by default; `--commit --batch=<id>` writes                      |
| `pnpm format`                                             | Prettier over the repo                                                                               |

CI runs lint, typecheck, the full test suite against a Postgres 17 service
container, and an env-free build — `pnpm build` must always succeed with no
env vars set, because required config is read lazily through `src/lib/env.ts`.

## Digging deeper

The interesting decisions live in [`docs/`](docs/):

- [Design](docs/DESIGN.md) — the data model and its invariants
- [ADR-001](docs/adr/ADR-001-vercel-neon-stack.md) — why Vercel + Neon
- [ADR-002](docs/adr/ADR-002-build-gated-migrations.md) — migrations run in
  the production build, gated on `main`
- [Runbooks](docs/RUNBOOK.md) — provisioning, the import cutover, data
  integrity checks, and recovering a failed migration

---

Built by [Kelvin Mwega](https://github.com/kelvinmwega).
