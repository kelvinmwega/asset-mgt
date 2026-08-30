import type { Metadata } from "next";
import type { AssetStatus } from "@prisma/client";
import Link from "next/link";
import { ArrowUpRight, BookText } from "lucide-react";

import { InstallPath } from "@/components/marketing/install-path";
import { ThemeToggle } from "@/components/theme-toggle";
import { StatusChip } from "@/components/ui/status-chip";

/**
 * The adopter-facing landing page — the only public route besides /signin.
 *
 * Direction and boundaries: .impeccable/surfaces/src-app-page-tsx.md.
 *
 * This route lives OUTSIDE the (app) group on purpose. It reads no session and
 * calls no `auth()`, so it adds no authorisation surface at all: the one
 * security change it needs is the middleware matcher opening `/`, guarded in
 * src/middleware.test.ts. A signed-in visitor landing here is not redirected —
 * the masthead's "Open the register" link is their way through, and that is
 * cheaper than a session read on the one page that must work for strangers.
 *
 * The (app)/page.tsx that used to redirect `/` to `/assets` is gone; both
 * files resolve to `/` and Next cannot have them coexist.
 *
 * Claims discipline (PRODUCT.md, "Evidence on Hand"): there are no users,
 * customers, stars, benchmarks, or uptime numbers, so none appear here. Every
 * statement below is checkable in the repository.
 *
 * The footer's licence and Source links are not decoration: AGPL section 13
 * asks a network-facing modified version to offer its users the source, and
 * the FSF's own suggested mechanism is exactly a "Source" link in the
 * interface. Anyone forking this and hosting it should keep them.
 */

/**
 * IMPECCABLE DIRECTION CONTRACT (seed 9f8807f2)
 *
 * IMPECCABLE DIRECTION CONTRACT
 * THESIS: The page is the fork. The install sequence is the hero; this refuses
 * the category default of a claim first hero with the install buried behind a
 * Docs link.
 * OWN-WORLD: Inherited app tokens. OKLCH neutrals, Geist Sans and Mono, the five
 * status chips, 0.625rem radius; one permanently dark terminal slab in both
 * themes.
 * STORY: A skeptical developer sees the real cost of adoption first, copies it,
 * and leaves for GitHub.
 * FIRST VIEWPORT: Quiet masthead; command slab at two thirds and display scale
 * with per step copy; five step rail at one third; no marketing sentence above
 * the commands.
 * FORM: The Install Path, candidate 5 of 7, seed 9f8807f2, surface scope, code
 * led.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with the
 * finish review, the verdict, DESIGN.md, and every shipping raster carrying its
 * provenance
 *
 * Lives in source, not in the emitted HTML. It was an HTML comment written
 * through dangerouslySetInnerHTML so it would survive the production build and
 * stay auditable; the T3 advisor ruled against that and is right. This is the
 * only anonymously reachable page in the app, the comment published internal
 * tooling metadata to every stranger, and it planted an injection sink on the
 * one route where a sink costs the most — for a build-audit convenience. The
 * contract is just as greppable here, and `git log` dates it either way.
 */
const REPO = "https://github.com/kelvinmwega/asset-mgt";
const DOCS = `${REPO}/tree/main/docs`;
const LICENSE = `${REPO}/blob/main/LICENSE`;

export const metadata: Metadata = {
  title: "Asset Register — self-hosted IT asset tracking",
  description:
    "A self-hosted IT asset register with append-only history, four roles and a repair-loop lifecycle. Clone it and run it.",
};

/** Illustrative only — a fresh install starts empty. Labelled as such below. */
const PREVIEW_ROWS: {
  tag: string;
  model: string;
  status: AssetStatus;
  site: string;
}[] = [
  { tag: "0231", model: 'MacBook Pro 14"', status: "ASSIGNED", site: "Main" },
  {
    tag: "0418",
    model: "Dell Latitude 5450",
    status: "IN_STOCK",
    site: "Main",
  },
  { tag: "0122", model: "Xerox VersaLink", status: "IN_REPAIR", site: "Depot" },
  {
    tag: "0087",
    model: "Lenovo ThinkPad T14",
    status: "RETIRED",
    site: "Main",
  },
];

/**
 * Every entry is enforced by the mechanism named beside it, not by convention.
 * Each is verifiable in the repository; nothing aspirational belongs here.
 */
const INVARIANTS: { rule: string; mechanism: string }[] = [
  {
    rule: "Nothing is ever deleted.",
    mechanism:
      "RETIRED is an asset's delete and deactivatedAt is a user's. db.asset.delete() appears nowhere in the codebase.",
  },
  {
    rule: "History is append-only.",
    mechanism:
      "AssetEvent and UserEvent take inserts only. Corrections are new events, written in the same transaction as the mutation they record.",
  },
  {
    rule: "A tag is mandatory from delivery onward.",
    mechanism:
      "Asset_tag_required_when_tracked, a database CHECK constraint. The application guard exists for the error message; the constraint is the enforcement.",
  },
  {
    rule: "Roles come from the database, never the token.",
    mechanism:
      "requireRole() is the first statement of every mutating server action and route handler. Middleware authenticates and never authorises.",
  },
  {
    rule: "Read-only staff are shown no person data.",
    mechanism:
      "It is not fetched for that viewer, not merely unrendered. personSelectFor(role) is the only place a Person select carrying personal data may be written.",
  },
  {
    rule: "Free-text notes are unsearchable.",
    mechanism:
      "Register search traverses tag, serial, make, model and category only — asserted by a real-database test, for every role including admin.",
  },
  {
    rule: "Concurrent status changes cannot race.",
    mechanism:
      "transitionAssetStatus locks the asset row with SELECT … FOR UPDATE before reading its current status.",
  },
];

export default function LandingPage() {
  return (
    <div className="bg-background text-foreground selection:bg-foreground selection:text-background min-h-screen">
      <header className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-5 py-5 sm:px-8">
        <div className="flex w-full items-center gap-2.5 sm:w-auto">
          <span className="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-md font-mono text-[0.7rem] font-semibold">
            AR
          </span>
          <h1 className="text-[0.9375rem] font-semibold tracking-tight">
            Asset Register
          </h1>
        </div>
        <span className="hidden flex-1 sm:block" />
        <nav
          aria-label="Project"
          className="flex w-full flex-wrap items-center justify-start gap-1 sm:w-auto sm:justify-end"
        >
          <a
            href={DOCS}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-200 focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
          >
            <BookText aria-hidden="true" className="size-4" />
            Docs
          </a>
          <a
            href={REPO}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm transition-colors duration-200 focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
          >
            GitHub
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </a>
          <Link
            href="/assets"
            className="border-border hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium whitespace-nowrap sm:ml-1 transition-colors duration-200 focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
          >
            Open the register
          </Link>
          <ThemeToggle />
        </nav>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-5 pt-6 pb-20 sm:px-8 sm:pt-10 sm:pb-28">
          <p className="text-muted-foreground mb-10 max-w-[62ch] text-[0.9375rem] leading-relaxed sm:mb-14">
            A self-hosted IT asset register. It tracks tagged kit from purchase
            through assignment, repair and retirement, with an append-only
            history and four server-enforced roles. Here is everything it takes
            to run your own copy.
          </p>

          <InstallPath />
        </section>

        <section className="border-border border-y">
          <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
            <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-center lg:gap-16">
              <div>
                <p className="text-muted-foreground font-mono text-xs tracking-[0.2em] uppercase">
                  Step 06
                </p>
                <p className="mt-3 font-mono text-2xl font-medium tracking-tight sm:text-3xl lg:text-4xl">
                  localhost:3000
                </p>
                <p className="text-muted-foreground mt-5 max-w-[58ch] text-sm leading-relaxed">
                  You are the admin. The register is empty and yours, with
                  categories and sites already seeded because an asset needs a
                  category. Add kit by hand, or bring an existing register in
                  from a spreadsheet with{" "}
                  <code className="text-foreground font-mono text-[0.8125rem]">
                    pnpm db:import
                  </code>{" "}
                  — dry run first, human sign-off, then commit.
                </p>
                <p className="text-muted-foreground mt-5 max-w-[58ch] text-sm leading-relaxed">
                  There is no public demo yet. The register has no anonymous
                  read path, and adding one is a security change rather than a
                  configuration flag — so it is being designed rather than
                  bolted on.
                </p>
              </div>

              <figure className="min-w-0">
                <div className="border-border bg-card overflow-hidden rounded-xl border">
                  <div className="border-border text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-[0.7rem] tracking-[0.2em] uppercase">
                    Register
                  </div>
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      Illustrative example of the asset register table
                    </caption>
                    <thead>
                      <tr className="border-border text-muted-foreground border-b text-left">
                        <th scope="col" className="px-4 py-2 font-medium">
                          Tag
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          Make / model
                        </th>
                        <th scope="col" className="px-4 py-2 font-medium">
                          Status
                        </th>
                        <th
                          scope="col"
                          className="hidden px-4 py-2 font-medium sm:table-cell"
                        >
                          Site
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {PREVIEW_ROWS.map((row) => (
                        <tr
                          key={row.tag}
                          className="border-border/60 border-b last:border-0"
                        >
                          <td className="px-4 py-2.5 font-mono tabular-nums">
                            {row.tag}
                          </td>
                          <td className="text-muted-foreground px-4 py-2.5">
                            {row.model}
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusChip status={row.status} />
                          </td>
                          <td className="text-muted-foreground hidden px-4 py-2.5 sm:table-cell">
                            {row.site}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <figcaption className="text-muted-foreground mt-3 text-xs">
                  Illustrative rows. A fresh install starts empty.
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
          <h2 className="max-w-[34ch] text-xl font-semibold tracking-tight sm:text-2xl">
            The audit trail is correct by construction, not by discipline.
          </h2>
          <p className="text-muted-foreground mt-4 max-w-[68ch] text-sm leading-relaxed">
            Each rule below is held up by the mechanism beside it. None of them
            depend on an operator remembering, or on a reviewer catching it.
          </p>

          <dl className="mt-10 grid gap-x-12 gap-y-8 sm:grid-cols-2">
            {INVARIANTS.map((item) => (
              <div key={item.rule} className="min-w-0">
                <dt className="text-[0.9375rem] font-medium tracking-tight">
                  {item.rule}
                </dt>
                <dd className="text-muted-foreground mt-2 text-sm leading-relaxed">
                  {item.mechanism}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="border-border border-t">
        <div className="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-8 text-sm sm:px-8">
          <a
            href={REPO}
            className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 transition-colors duration-200 hover:underline focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
          >
            Source
          </a>
          <a
            href={DOCS}
            className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 transition-colors duration-200 hover:underline focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
          >
            Design notes, ADRs and runbooks
          </a>
          <a
            href={LICENSE}
            className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 transition-colors duration-200 hover:underline focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
          >
            AGPL-3.0
          </a>
          <span className="hidden flex-1 sm:block" />
          <span>
            Built by{" "}
            <a
              href="https://github.com/kelvinmwega"
              className="hover:text-foreground focus-visible:ring-ring/50 rounded-sm underline-offset-4 transition-colors duration-200 hover:underline focus-visible:ring-[3px] focus-visible:outline-none motion-reduce:transition-none"
            >
              Kelvin Mwega
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
