# ADR-001: Vercel + Neon full-stack Next.js, deviating from the studio spine

- **Status:** Accepted (client directive 2026-07-28; advisor-approved 2026-07-28)
- **Deciders:** Kelvin (studio), advisor (ruling at /scaffold T3 gate)

## Context

Internal IT asset register: ~400 assets, 3 writers / 70 readers, replacing a legacy SaaS register before a pricing change. Run cost must be near-zero at idle or the build's economics fail. On 2026-07-28 the client directed deployment on Vercel with a cheaper database than AWS, and accepted the Vercel Hobby commercial-use ToS risk. The studio spine (AWS + Terraform, NestJS when a server is justified, Cognito auth) is deviated from on five axes.

## Decision

A single Next.js 15 App Router app (dynamic SSR) on Vercel serverless functions pinned to `fra1`; Neon Postgres in `eu-central-1` (pooled connection string) with Prisma; Auth.js v5 magic-link via Resend (org SSO if the client IdP materialises), JWT sessions with split edge/Node config; no separate API service; no Terraform — configuration lives as repo artefacts (`vercel.json`, `.env.example`, README runbook).

## Consequences

- **$0/month at this usage** (Vercel Hobby + Neon Free + Resend Free) — the number that makes "own it instead of renting it" true.
- **Hobby ToS suspension risk** (commercial use): accepted and named; mitigations are Vercel Pro ($20/month, cost parity with the escaped subscription) and an independent nightly `pg_dump` (GitHub Actions cron) required before AM-04 cutover sign-off, keeping the data portable if suspension lands mid-week.
- **EU processing of Kenyan staff PII** requires a Kenya DPA 2019 (ss. 48–49) transfer-safeguards note, written at scaffold; ODPC registration status is the client's obligation via its own counsel.
- **Reversibility is cheap:** a NestJS service can be extracted if Oracle integration later demands long-running jobs; Vercel and Neon Terraform providers exist if the studio later enforces the spine.
