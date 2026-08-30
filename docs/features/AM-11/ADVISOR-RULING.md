# AM-11 — Adopter-facing landing page: T3 advisor ruling and conditions

- **Date:** 2026-08-30
- **Tier:** T3 (auth-touching — the deny-by-default matcher opens a public route)
- **Scope:** public landing page at `/`, middleware matcher `.*` → `.+`
- **Verdict:** **APPROVED with conditions.** "The mechanism is correct and is the
  minimal correct spelling."

Recorded per `CLAUDE.md` §Process — "every condition it names either met or
explicitly overruled in the PR body, one by one, in writing". Paste this section
into the PR body.

## What the advisor verified independently

Not inference — it read the **compiled** matcher out of
`.next/server/middleware-manifest.json` and brute-forced the short path space:

```
^(?:\/(_next\/data\/[^/]{1,}))?(?:\/((?!api\/auth(?:\/|$)|signin(?:\/|$)|_next\/static|_next\/image|favicon\.ico).+))(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$
```

`/` is the only public path. Zero others. The source-level test's `^literal$`
approximation was shown sound **in the safe direction**: the real pattern is the
approximation plus three optional groups, so approx-match ⇒ real-match. It can
only err by calling something public that Next actually gates.

It also strengthened the rejection of the alternative: the alternation matches
the remainder _after_ the leading slash, so "root only" spells out as `(?!…|$)`
— which **is** `.+`. Adding `/` to the alternation is a more fragile way of
writing the same thing.

## Conditions

### Blocking

| #   | Condition                                                                                | Status                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `signin/page.tsx` rationale is now false — it names `src/app/page.tsx` as the redirector | **MET** — corrected to name the `(app)` layout's `requireRole`, which is what actually bounces a deactivated user. Guard unchanged; only the reason is now true.                                                                                          |
| 2   | `signin/page.tsx` `redirect("/")` lands signed-in users on marketing copy                | **MET** — now `redirect("/assets")`. `page.integration.test.tsx` updated to assert it.                                                                                                                                                                    |
| 3   | Gitignore the capture directories before they reach a public repo                        | **MET** — `.impeccable/*`, `.playwright-mcp/`, `/*.png` added. Verified with `git check-ignore -v`.                                                                                                                                                       |
| 4   | `src/app/page.tsx:13` points into an ignored directory                                   | **MET** — `!.impeccable/surfaces/` re-includes the directory (not just its contents), so briefs stay committed and the pointer resolves. Everything else the tool writes stays ignored.                                                                   |
| 5   | `dangerouslySetInnerHTML` on the only anonymous-reachable page                           | **MET, by removal.** The direction contract moved to a source docblock. It was there so the contract survived the production build; that convenience is not worth an injection sink plus published internal metadata on the one route a stranger reaches. |
| 6   | Record the two tripwires the guard cannot see                                            | **MET** — `basePath` is prepended with no opt-out, and middleware precedes all rewrites. Both in the `src/middleware.ts` docblock, pointing at the probe.                                                                                                 |

### Follow-up

| #   | Condition                                                                   | Status                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Probe the compiled artefact in CI, after the build                          | **MET — implemented now, not deferred.** `scripts/matcher-probe.mjs` + `pnpm matcher:probe` as a CI step after `pnpm build` (it cannot be a vitest test: CI runs `pnpm test` before `pnpm build`, so no manifest exists yet). Brute-forces 11,111 paths over a hostile alphabet. Red-proved: reverting `.+`→`.*` and rebuilding fails it. |
| 8   | `public/` is empty and everything in it except `favicon.ico` will be gated  | **TRACKED.** Nothing is broken today. `/robots.txt`, `/sitemap.xml`, `/manifest.json`, `/og.png` are in the probe's `MUST_STAY_GATED` list as the live tripwire — the first OG image or the AM-06 PWA manifest fails the probe, which is the point.                                                                                       |
| 9   | No data fetch may be added to `/` without a new ruling                      | **TRACKED, unguarded.** The zero-DB property is what makes an anonymous front door safe on a `force-dynamic` route. Advisor confirmed the built `/` bundle contains zero `@prisma/client` references. A guard asserting that against the build output is the natural shape and belongs with this issue.                                   |
| 10  | If the demo is ever built in-repo, the bypass must be build-time impossible | **TRACKED** — see below; it is now moot for the planned design.                                                                                                                                                                                                                                                                           |

## Ruling on the public demo (question 4)

**Separate deployment, separate database. Not negotiable.** The decisive reason
is one the design had not reached:

> A demo needs periodic reset, and this codebase forbids deletion in code _and_
> in SQL. Anonymous writes accumulate permanent garbage in append-only
> `AssetEvent`/`UserEvent`, and resetting requires `TRUNCATE`. **In one database,
> "reset the demo" and "nothing is ever deleted" cannot both be true.** In a
> throwaway database the rule is vacuous — there is no audit trail worth
> protecting.

Reinforcing: a role switcher is a client-chosen role, and a demo branch inside
`requireRole` puts a bypass in the most load-bearing primitive in the repo;
`personSelectFor(ADMIN_IT)` would be one seeding mistake away from live PII.

This change _helps_ that story: `/` is already session-free and reusable by a
demo build, and the probe's "exactly one path" assertion is a tripwire that
fails loudly on any attempt to open register subtrees.

## Notes carried forward

- **`docs/LEARNINGS.md` does not exist**, despite `CLAUDE.md` §Process and the
  `delivery-learnings` skill both referencing it. No prior art was available on
  this decision class. Worth a `/retro` entry.
- The red-proving done before the consult was correct but **narrower than it
  read**: it proved two specific mutations fail. The brute force is the negative
  control that closes the class, which is why condition 7 was implemented rather
  than filed.
