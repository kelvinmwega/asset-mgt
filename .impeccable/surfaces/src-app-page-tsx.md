---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/middleware.ts"]
---

# Surface brief — adopter-facing page (`/`)

**Scope:** one public page at `/`, same repo and deploy as the app.
**Visitor mode:** Persuade.
**Seed:** `9f8807f2` · surface scope · structure #5 of 7, assigned by roll · code-led.

## Audience and job

A developer or IT lead who owns an asset-tracking problem, arriving cold from
search, a link, or the repo. Skeptical and fast — inside a minute they decide
whether this is a maintained system or an abandoned scaffold with a good README.
A meaningful share arrive on a phone, on patchy mobile data.

**Primary action:** clone it and run it. GitHub is the destination.
**Secondary:** open the demo — which exists to return them to the primary action.

## Proof and content

Verifiable evidence only: the running deployment; the docs trail (two ADRs,
per-feature designs, four retros, a runbook); real-Postgres integration tests,
mutation testing over guard-bearing modules, an env-free CI build; AGPL-3.0.

**Never stated:** stars, forks, users, testimonials, benchmarks, uptime,
pricing, customers. **The hosted tier does not appear on this page at all.**

## Chosen direction — The Install Path

_The page is the fork._ The command sequence is the hero at display scale with
no marketing sentence above it. The category opens with a claim and buries the
install; this opens with the actual cost of adoption and lets that be the flex.

Visual authority is **inherited, not invented** — the app's OKLCH tokens, Geist
Sans/Mono, the five-status chip family, `--radius: 0.625rem`. The page hands the
visitor into the live product, and a different skin would undercut the one thing
being proven.

**Memorable moment:** copying a command advances its step in the rail — a
progress indicator for something happening in the visitor's own terminal.

**Closing band:** the invariant ledger — one-line rules paired with the
mechanism that enforces each (CHECK constraint, chokepoint function,
append-only table, real-DB test). This is what converts a skeptic.

**Honest risk:** underuses the demo; a visitor who wanted to _see_ the product
first meets a shell prompt. Mitigated by step five's prominence. Named alternate
if that risk lands wrong: **Register as Hero**.

## Boundaries

Untouched: every existing route, the authorisation model, `requireRole`, the
token layer, the `AssetEvent`/`UserEvent` invariants.

Anti-goals: no hosted-tier pitch · no fabricated social proof · no invented
logo · no new visual world · no hero sentence above the commands · no
scroll-jacking · no analytics or cookie banner.

## States and ranges

Command block: 4 commands, ~60 chars. States idle / copied /
clipboard-unavailable (commands stay selectable regardless). Demo band: live /
**demo unavailable** — a real degraded state, not a dead link. Ledger: 5–8
entries. **No-JS:** page reads completely, commands selectable. Phone: commands
wrap rather than side-scroll, copy control in thumb reach.

## Unresolved decisions

1. ~~`/` must become public against deny-by-default middleware.~~ **Resolved
   2026-08-30** — T3 advisor APPROVED `.+` as "the minimal correct spelling",
   verified against the compiled matcher. Six blocking conditions met, the
   compiled-artefact probe implemented. Record:
   `docs/features/AM-11/ADVISOR-RULING.md`.
2. **Public demo instance does not exist**, and the advisor has now ruled on its
   shape: **separate deployment, separate database, not negotiable.** A demo
   needs periodic reset; this codebase forbids deletion in code and in SQL, so
   in one database "reset the demo" and "nothing is ever deleted" cannot both be
   true. This page ships pointing at `localhost:3000` and says plainly that no
   public demo exists yet.
3. ~~LICENSE file does not exist.~~ **Resolved 2026-08-30** — verbatim AGPL-3.0
   written to `LICENSE`; the footer now carries the licence and Source links,
   which is also how the page meets AGPL section 13's network-source ask.
4. Repo URL is `github.com/kelvinmwega/asset-mgt` (verified from git remote).
   Older docs reference an `App-Artery` path; do not use it.
