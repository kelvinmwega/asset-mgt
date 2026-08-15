import Link from "next/link";
import { redirect } from "next/navigation";
import { AssetStatus, type Prisma } from "@prisma/client";
import { Plus } from "lucide-react";
import { z } from "zod";
import { CONDITION_LABELS } from "@/lib/labels";
import { assetDisplayName } from "@/lib/asset-display";
import { requireRole } from "@/lib/authz";
import { getDb } from "@/lib/db";
import { assetSearchWhere, normaliseSearchTerm } from "@/lib/asset-search";
import {
  PERSON_NAME_SELECT,
  canViewAssignments,
} from "@/lib/person-visibility";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import { AssetTagLink } from "@/components/asset-tag-link";
import { EstateBar, type EstateCounts } from "@/components/estate-bar";
import { AssetCardList } from "./asset-card-list";
import { RegisterPager } from "./register-pager";
import {
  ResponsiveTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Empty selects submit ""; normalise before validation, not after. */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/**
 * Whitespace-collapse the search term at the PARSE boundary, so exactly one
 * normalised string reaches the predicate, the exact-tag lookup, every link on
 * this page and the input's own value.
 *
 * Before validation rather than after (LEARNINGS §Zod): `.transform()` runs
 * after the validators, so a term of three spaces would satisfy `.min(1)` and
 * only then collapse to "" — a search for nothing that reads as a search for
 * something. Normalising first makes an all-whitespace box the same thing as an
 * empty one, which is what a reader who hit Enter on it meant.
 */
const normaliseTerm = (value: unknown) =>
  typeof value === "string"
    ? blankToUndefined(normaliseSearchTerm(value))
    : value;

/**
 * A column header that is also its own sort control.
 *
 * A link, not a button: sort is URL state, so this works with JavaScript off
 * and a sorted register is a shareable link. `aria-sort` on the cell is what
 * tells a screen reader which column is ordered and which way — the arrow is
 * decorative and hidden from it.
 */
function SortableHead({
  column,
  label,
  active,
  direction,
  href,
}: {
  column: SortColumn;
  label: string;
  active: SortColumn;
  direction: "asc" | "desc";
  href: string;
}) {
  const isActive = column === active;
  return (
    <TableHead
      aria-sort={
        isActive ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <Link
        href={href}
        className="hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        {label}
        <span aria-hidden="true" className={isActive ? "" : "opacity-0"}>
          {direction === "asc" ? "↑" : "↓"}
        </span>
      </Link>
    </TableHead>
  );
}

/**
 * The columns a reader may sort by, and how each maps onto Prisma.
 *
 * "Held by" is deliberately absent: the holder is fetched by a SECOND query
 * (see below), so the database cannot order the register by it without the join
 * this page exists to avoid for STAFF_RO. Offering a sort that silently did
 * nothing would be worse than not offering it.
 */
const SORT_COLUMNS = [
  "tag",
  "item",
  "category",
  "status",
  "site",
  "condition",
] as const;

type SortColumn = (typeof SORT_COLUMNS)[number];

function orderByFor(
  column: SortColumn,
  direction: "asc" | "desc",
): Prisma.AssetOrderByWithRelationInput[] {
  // `nulls: "last"` on every nullable column: an untagged asset or one with no
  // site is missing information, and missing information belongs at the end
  // whichever way the column is pointed — not floated to the top on desc.
  const primary: Record<SortColumn, Prisma.AssetOrderByWithRelationInput[]> = {
    tag: [{ tag: { sort: direction, nulls: "last" } }],
    item: [{ make: direction }, { model: direction }],
    category: [{ category: { name: direction } }],
    // The enum's declaration order is the lifecycle order, so sorting by status
    // walks ON_ORDER → RETIRED rather than alphabetically.
    status: [{ status: direction }],
    site: [{ site: { name: direction } }],
    condition: [{ condition: { sort: direction, nulls: "last" } }],
  };
  // A stable tie-break, so two assets that match on the sort key keep a fixed
  // order between renders instead of drifting with the planner.
  return [...primary[column], { id: "asc" }];
}

// A malformed shared link renders the default register rather than a 500
// (LEARNINGS §Zod).
//
// Every param the UI can produce has to appear HERE too: `.object()` strips
// unknown keys silently, so a filter wired into the where-builder but not the
// schema is dropped with no error anywhere (LEARNINGS §Zod).
//
// `.catch(undefined)` per field, not one safeParse over the object: the object
// form is all-or-nothing, so a single junk param discards every VALID one
// beside it. That was survivable with three filters and is not with five —
// a typo in `dir` would silently throw away the status and category someone
// had actually chosen. Each field now falls back on its own.
const filterSchema = z.object({
  // The lookup term (AM-07). It is HERE and not only in the where-builder and
  // the form because `.object()` strips unknown keys silently: a `q` wired into
  // both of those but missing from this schema is dropped with no error
  // anywhere, and the search box then does nothing at all for reasons no stack
  // trace explains.
  q: z.preprocess(normaliseTerm, z.string().min(1).optional().catch(undefined)),
  status: z.preprocess(
    blankToUndefined,
    z.enum(AssetStatus).optional().catch(undefined),
  ),
  categoryId: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional().catch(undefined),
  ),
  siteId: z.preprocess(
    blankToUndefined,
    z.string().min(1).optional().catch(undefined),
  ),
  sort: z.preprocess(
    blankToUndefined,
    z.enum(SORT_COLUMNS).optional().catch(undefined),
  ),
  dir: z.preprocess(
    blankToUndefined,
    z.enum(["asc", "desc"]).optional().catch(undefined),
  ),
  // Coerced, because a query string only ever carries text. `.int().min(1)`
  // is the floor: "0", "-3", "2.7", "abc", a repeated param arriving as an
  // array, and Infinity all fall through to undefined and therefore to page 1
  // — none of them reaches `skip`.
  //
  // `.int()` also rejects anything outside the safe-integer range, so a
  // hand-edited `?page=99999999999999999999` cannot hand Postgres a nonsense
  // OFFSET. That is ZOD 4 behaviour specifically and worth naming, because
  // zod 3's `.int()` was a bare Number.isInteger check that let unsafe
  // integers through — a review read this comment against the zod 3 rule and
  // called it wrong (PR #17). Verified against zod 4.4.3: the oversized string
  // above fails with `{ code: "too_big", origin: "int", maximum:
  // 9007199254740991 }`, and "1e400" fails as invalid_type once it coerces to
  // Infinity. A zod major bump is the thing that would quietly falsify this;
  // page.integration.test.tsx §"malformed page" is the guard that would notice.
  //
  // Load-bearing, not belt-and-braces: `skip` is computed from the REQUESTED
  // page, and that query is dispatched before `pageCount` is known, so the
  // out-of-range clamp below does NOT protect it. This schema is the only
  // guard `skip` has.
  //
  // This only floors the page. It cannot CEIL it, because the last page is not
  // known until the count comes back — `?page=999` is parsed as 999 here and
  // clamped after the query below.
  page: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).optional().catch(undefined),
  ),
});

/**
 * Rows per page.
 *
 * The client's legacy export is ~400 assets, so 50 is eight pages of a
 * register someone scans rather than reads — enough that paging is rare, few
 * enough that the page stays a page (issue #8 measured 402 rows as 15,965px
 * of scroll and 10,481 DOM nodes).
 */
const PAGE_SIZE = 50;

export default async function AssetsPage({
  searchParams,
}: {
  // Async in Next 15 — a non-async signature typechecks and fails the build.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await requireRole(
    "ADMIN_IT",
    "PROCUREMENT",
    "FINANCE",
    "STAFF_RO",
  );
  const canWrite = role === "ADMIN_IT" || role === "PROCUREMENT";
  // Checked BEFORE the holder query, never in the JSX: for a STAFF_RO viewer the
  // register carries no assignment and no person data at all, because none is
  // fetched (advisor condition 9).
  const canSeeHolders = canViewAssignments(role);

  const parsed = filterSchema.safeParse(await searchParams);
  const filters = parsed.success ? parsed.data : {};

  // Truthiness, not != null: "" passes a null check and matches nothing
  // (LEARNINGS §Prisma).
  //
  // Two where clauses, and the difference between them is deliberate. The
  // estate bar has to show what EVERY status holds — otherwise filtering to
  // "In repair" would leave a bar reading "In repair 21" and nothing else, and
  // there would be no way back. So the bar counts against everything except the
  // status filter, while the table applies all three. This is NOT the
  // count-query-parity bug (LEARNINGS §Prisma): the clauses differ by exactly
  // one field, on purpose, and the counts describe the same set the reader is
  // choosing between.
  const scopeFilters: Prisma.AssetWhereInput = {};
  if (filters.categoryId) scopeFilters.categoryId = filters.categoryId;
  if (filters.siteId) scopeFilters.siteId = filters.siteId;
  // `q` goes in `scopeFilters`, WITH category and site — not in `where` alone.
  //
  // The design question is what the estate bar should count while a search is
  // running: the whole estate, or the search results? Counting the whole estate
  // would leave the bar reading "In stock 3,904" above a table of four matching
  // rows, and clicking that chip then lands you on a count that was never true
  // of anything you could see. The bar's job is to break down the set you are
  // looking at, along the one axis it owns.
  //
  // A search is the same KIND of narrowing as a category or a site: it chooses
  // which assets are in play. Status is the one dimension the bar itself
  // controls, which is why it and only it is excluded. `q` therefore sits on
  // the scope side of that line, and "of N" in the header counts search hits.
  //
  // Composed under `AND` rather than spread. `assetSearchWhere` returns an `OR`
  // today; spreading it would silently clobber a sibling `OR` if this clause
  // ever grows one, and the failure would be a wrong result set rather than a
  // type error.
  if (filters.q) scopeFilters.AND = assetSearchWhere(filters.q);

  const where: Prisma.AssetWhereInput = { ...scopeFilters };
  if (filters.status) where.status = filters.status;

  const sortColumn: SortColumn = filters.sort ?? "tag";
  const sortDirection = filters.dir ?? "asc";

  const db = getDb();

  // A scanned barcode should open the asset, not a one-row register.
  //
  // EQUALITY, never `contains`. A partial match that redirected would drop a
  // reader typing "REG-1" into whichever asset happened to sort first — an
  // arbitrary asset, silently, with no way to tell it was not the one they
  // meant. `tag` is unique, so exact match means exactly one asset or none.
  //
  // Runs AFTER `requireRole` above, which is the first statement of this
  // component: a reader who may not see the register must not be able to probe
  // for tag existence through the redirect either.
  //
  // Case-sensitive, and that degrades correctly rather than failing: a
  // mistyped case falls through to the search below, where `mode: "insensitive"`
  // finds the same asset and renders a one-row register with a link to it.
  if (filters.q) {
    const exactTagMatch = await db.asset.findUnique({
      where: { tag: filters.q },
      select: { id: true },
    });
    if (exactTagMatch) redirect(`/assets/${exactTagMatch.id}`);
  }

  const requestedPage = filters.page ?? 1;

  // One definition of a page of rows, so the out-of-range retry below cannot
  // drift from the first attempt — a second hand-written findMany is exactly
  // how a retry ends up with a different select or a different orderBy.
  const pageOfAssets = (page: number) =>
    db.asset.findMany({
      where,
      orderBy: orderByFor(sortColumn, sortDirection),
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        tag: true,
        make: true,
        model: true,
        description: true,
        status: true,
        condition: true,
        category: { select: { name: true } },
        site: { select: { name: true } },
      },
    });

  const [requestedAssets, total, statusCounts, categories, sites] =
    await Promise.all([
      pageOfAssets(requestedPage),
      // THE SAME `where` OBJECT the findMany above reads — not a copy, not a
      // rebuild. A count computed against a different clause makes "51–100 of
      // N" a lie, and it survives review because both halves look right on
      // their own (LEARNINGS §Prisma, count-query parity). Sharing the
      // identifier is what makes the parity checkable at a glance.
      //
      // This is NOT the `scopeFilters` the estate bar counts against below.
      // That asymmetry is deliberate and documented above; this one would be a
      // bug.
      db.asset.count({ where }),
      db.asset.groupBy({
        by: ["status"],
        where: scopeFilters,
        _count: { _all: true },
      }),
      db.category.findMany({ orderBy: { name: "asc" } }),
      db.site.findMany({ orderBy: { name: "asc" } }),
    ]);

  // Clamped AFTER the count, because the last page is not knowable before it.
  // Max(1, …) so an empty register is page 1 of 1 rather than page 1 of 0.
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Out of range falls back to page 1 — NOT to the last page. `Math.min` was
  // the first spelling here and it is wrong: it answers `?page=999` on a
  // three-page register with page 3, silently teleporting a reader to rows
  // they did not ask for and cannot tell are not what they requested. An
  // out-of-range page is a broken link, and page 1 is where every other reset
  // on this page already sends you — changing the sort, the status or a
  // filter. One answer to "this view is not where you thought you were".
  const page = requestedPage > pageCount ? 1 : requestedPage;

  // `?page=999` on a three-page register renders page 1, not an empty table.
  //
  // Re-queried rather than redirected. `redirect()` would leave the URL
  // honest, but it throws NEXT_REDIRECT out of the component — so the "renders
  // page 1" acceptance criterion would become "throws a control-flow
  // exception", untestable at this seam and a worse experience on a stale
  // bookmark than simply showing the register. Cost is one extra query on a
  // path only a hand-edited or stale link reaches; the in-range path, which is
  // every real page view, still costs exactly one round trip because the count
  // rides along in the Promise.all above rather than gating it.
  const assets =
    page === requestedPage ? requestedAssets : await pageOfAssets(page);

  // groupBy omits statuses with no rows; the bar needs all five present, so a
  // zero is a real answer ("nothing is in repair") rather than a missing key.
  const counts: EstateCounts = {
    ON_ORDER: 0,
    IN_STOCK: 0,
    ASSIGNED: 0,
    IN_REPAIR: 0,
    RETIRED: 0,
  };
  for (const row of statusCounts) {
    counts[row.status] = row._count._all;
  }

  // A second query rather than an `assignments` include on the one above: a
  // role-conditional include gives the whole row a union type, and the branch
  // that matters most — the one where nothing person-shaped is fetched — is
  // then the hardest to read. One extra query, and the STAFF_RO path never
  // touches the Assignment or Person tables.
  //
  // Scoped to `assets`, which is the CLAMPED page — so this became page-sized
  // (at most PAGE_SIZE ids) for free when pagination landed. It must stay
  // below the clamp: reading `requestedAssets` here would fetch holders for a
  // page that is not the one being rendered.
  const holders =
    canSeeHolders && assets.length > 0
      ? await db.assignment.findMany({
          where: { returnedAt: null, assetId: { in: assets.map((a) => a.id) } },
          // The register shows a name and nothing else, so it fetches a name
          // and nothing else. personSelectFor(ADMIN_IT) would pull an email
          // into this payload that no cell renders — within the tier, so not a
          // leak, but it spends the "data not fetched cannot leak" property for
          // no benefit.
          select: { assetId: true, person: { select: PERSON_NAME_SELECT } },
        })
      : [];
  // At most one open assignment per asset — the partial unique index is what
  // makes this Map safe to build.
  const holderByAsset = new Map(
    holders.map((holder) => [holder.assetId, holder.person]),
  );

  // Mapped ONCE, then rendered twice — the table above md and the card list
  // below it. Both shapes read this array, so a role-conditional cannot be
  // right in one shape and missing from the other.
  //
  // There is deliberately NO `canSeeHolders ?` here. holderByAsset is empty for
  // a STAFF_RO viewer because the query above never ran, so a ternary would be
  // unreachable — it was written, and deleting it left every test green
  // (LEARNINGS §Testing: a secondary guard behind a working primary defends
  // nothing you can demonstrate). The guard is the fetch, and only the fetch:
  // data that was never selected cannot leak through any later UI change.
  // `total`, never `assets.length`. Before pagination those were the same
  // number and this read from the rendered rows; now `assets.length` is at
  // most PAGE_SIZE, so the old arithmetic would have quietly relabelled a
  // 402-asset register as "50 of 402" — the header's job is to say how much
  // there IS, and the footer's is to say which slice you are on.
  //
  // `estateTotal` sums the estate bar's counts, which are taken against
  // `scopeFilters` — everything except the status filter. So `isFiltered` is
  // true exactly when a status is narrowing the set, and the header then says
  // what the number is a subset OF rather than looking like the whole
  // register. Singular/plural matters: "1 assets" reads as a bug.
  const estateTotal = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const isFiltered = total !== estateTotal;
  const summary = isFiltered
    ? `${total} of ${estateTotal}`
    : `${total} ${total === 1 ? "asset" : "assets"}`;

  // 1-based and inclusive, because the footer is read by a person. Zero rows
  // is the one case where a "start" would be a fiction, and the empty state
  // below owns that case anyway.
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = (page - 1) * PAGE_SIZE + assets.length;

  const rows = assets.map((asset) => ({
    id: asset.id,
    tag: asset.tag,
    make: asset.make,
    model: asset.model,
    description: asset.description,
    status: asset.status,
    categoryName: asset.category.name,
    siteName: asset.site?.name ?? null,
    condition: asset.condition,
    holder: holderByAsset.get(asset.id) ?? null,
  }));

  /**
   * Every control on this page is a link, so each one has to rebuild the whole
   * query string. One builder, so a new param cannot be preserved by the status
   * chips and dropped by the column headers.
   */
  const hrefWith = (overrides: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | null | undefined> = {
      // Without this line every sort header and every estate chip silently
      // drops the search: you sort a set of four results and get the whole
      // register back, sorted. It is the same class of bug as a pager that
      // rebuilds the query string from scratch, and it is invisible until
      // somebody clicks a header while searching.
      q: filters.q ?? null,
      status: filters.status ?? null,
      categoryId: filters.categoryId ?? null,
      siteId: filters.siteId ?? null,
      sort: filters.sort ?? null,
      dir: filters.dir ?? null,
      // The CLAMPED page, not `filters.page`: a reader who arrived on
      // `?page=999` and is being shown page 1 must not have 999 threaded back
      // into every link on the screen. Page 1 is the absence of the param, so
      // the default register keeps a bare `/assets` URL.
      //
      // Carried by default and reset EXPLICITLY at each control below, rather
      // than omitted here and added where wanted. Both spellings produce the
      // same URLs today; this one makes "does this control reset the page?" a
      // question with a visible answer at every call site, instead of one
      // answered by the absence of a line.
      page: page > 1 ? String(page) : null,
      ...overrides,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const query = params.toString();
    return query ? `/assets?${query}` : "/assets";
  };

  const sortHref = (column: SortColumn) =>
    hrefWith({
      sort: column,
      // Clicking the active column flips it; clicking a new one starts
      // ascending, which is the reading order for every column here.
      dir: column === sortColumn && sortDirection === "asc" ? "desc" : "asc",
      // Re-sorting reorders every row, so page 3 of the old order has nothing
      // to do with page 3 of the new one. Changing what you are looking at
      // returns you to the start of it.
      page: null,
    });

  /** Movement WITHIN the current view, so this is the one control that keeps it. */
  const pageHref = (target: number) =>
    hrefWith({ page: target > 1 ? String(target) : null });

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        {/* The title is a label, not a masthead. An operator opening this forty
            times a day knows what page they are on — the rail says so, and it
            is the app's home. What changes is the count, so the count gets the
            weight the heading gives up. */}
        <div className="flex items-baseline gap-2.5">
          <h1 className="font-semibold tracking-tight">Asset register</h1>
          {/* Counts describe what is on screen, so they follow the filters
              rather than the whole table — a filtered register that still
              claimed the full count would be lying about what you can see.
              The per-status breakdown that used to live here is now the estate
              bar below, which shows the same numbers and acts on them. */}
          <p className="text-muted-foreground font-mono text-sm tabular-nums">
            {summary}
          </p>
        </div>
        {/* "Add asset" is a page action, not navigation — it stays here after
            the shell took over the nav links. */}
        {canWrite ? (
          <Button asChild size="sm">
            <Link href="/assets/new">
              <Plus aria-hidden="true" />
              Add asset
            </Link>
          </Button>
        ) : null}
      </div>

      {/* The status summary IS the status filter (AM-09 DESIGN §4.2). It
          replaces the Status select below, so status now takes one click
          instead of select-then-submit — and the counts it shows are what make
          the click worth offering. */}
      <EstateBar
        counts={counts}
        active={filters.status ?? null}
        // `page: null` — changing the status changes the set, so page 3 of the
        // old set is meaningless in the new one and would often be past its
        // end. Same rule as the sort headers.
        hrefFor={(status) => hrefWith({ status, page: null })}
      />

      {/* A plain GET form: filters live in the URL, so a filtered register is
          a shareable link and the page stays a server component.
          `sort`/`dir` ride along as hidden inputs — without them, submitting
          the category filter would silently reset a chosen sort, and status
          would be dropped entirely because the bar owns it now.

          There is deliberately NO hidden `page` input, and adding one would be
          a bug. A GET form submits its fields and nothing else, so the absence
          of the input IS the reset: choosing a different category drops you
          back to page 1 of the new set, which is the only page guaranteed to
          exist in it. That absence is also what resets the page on a new
          search — landing a fresh search on page 7 of the set it replaced is
          the bug this prevents. */}
      <form method="get" className="flex flex-wrap items-end gap-3">
        {filters.status ? (
          <input type="hidden" name="status" value={filters.status} />
        ) : null}
        {filters.sort ? (
          <input type="hidden" name="sort" value={filters.sort} />
        ) : null}
        {filters.dir ? (
          <input type="hidden" name="dir" value={filters.dir} />
        ) : null}
        {/* First control in the row: the lookup is what an operator holding a
            device in one hand came here to do, and the two selects are the
            slower path. `type="search"` for the browser's own clear
            affordance — the "Clear" link beside the button resets everything,
            which is a different intention.

            The placeholder names the fields it matches, because a search box
            that quietly declines to match the thing you typed is worse than one
            that says what it covers. It does NOT match holder names, by the
            AM-07 ruling — see src/lib/asset-search.ts. */}
        <div className="flex w-full flex-col gap-1.5 sm:w-auto">
          <Label htmlFor="filter-q">Search</Label>
          <Input
            id="filter-q"
            type="search"
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Tag, serial, make, model, category"
            className="w-full sm:w-72"
          />
        </div>
        {/* `w-full sm:w-auto` on the wrapper and the select alike. The Select
            primitive is `w-fit`, so it sizes to its WIDEST option — one long
            category or site name and the filter row runs off the side of a
            phone, taking the whole page's horizontal scroll with it (measured
            at 390px: a 488px document). Matching the search input's own
            `w-full sm:w-72` above. */}
        <div className="flex w-full flex-col gap-1.5 sm:w-auto">
          <Label htmlFor="filter-category">Category</Label>
          <Select
            id="filter-category"
            name="categoryId"
            defaultValue={filters.categoryId ?? ""}
            className="w-full sm:w-fit"
          >
            <option value="">All</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex w-full flex-col gap-1.5 sm:w-auto">
          <Label htmlFor="filter-site">Site</Label>
          <Select
            id="filter-site"
            name="siteId"
            defaultValue={filters.siteId ?? ""}
            className="w-full sm:w-fit"
          >
            <option value="">All</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Filter
        </Button>
        <Link
          href="/assets"
          className="text-muted-foreground pb-2 text-sm underline underline-offset-4"
        >
          Clear
        </Link>
      </form>

      {assets.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No assets match. {canWrite ? "Add one to get started." : null}
        </p>
      ) : (
        <>
          {/* The table region owns the vertical scroll so the header can stick
              to it — and so the estate bar and filters stay on screen while a
              400-row register scrolls under them.

              containerClassName is deliberately NOT SCROLL_PANE: this value is
              tuned to this page's chrome (title, estate bar, filter row) and
              means nothing on a page that does not have them. */}
          <ResponsiveTable
            tableTestId="asset-table"
            cardsTestId="asset-card-list"
            cards={<AssetCardList assets={rows} />}
            sticky
            containerClassName="max-h-[calc(100vh-19rem)] min-h-64"
          >
            <TableHeader>
              <TableRow>
                <SortableHead
                  column="tag"
                  label="Tag"
                  active={sortColumn}
                  direction={sortDirection}
                  href={sortHref("tag")}
                />
                <SortableHead
                  column="item"
                  label="Make / model"
                  active={sortColumn}
                  direction={sortDirection}
                  href={sortHref("item")}
                />
                <SortableHead
                  column="category"
                  label="Category"
                  active={sortColumn}
                  direction={sortDirection}
                  href={sortHref("category")}
                />
                <SortableHead
                  column="status"
                  label="Status"
                  active={sortColumn}
                  direction={sortDirection}
                  href={sortHref("status")}
                />
                {/* Not sortable: the holder comes from a second query, so the
                      database cannot order by it. See SORT_COLUMNS. */}
                {canSeeHolders ? <TableHead>Held by</TableHead> : null}
                <SortableHead
                  column="site"
                  label="Site"
                  active={sortColumn}
                  direction={sortDirection}
                  href={sortHref("site")}
                />
                <SortableHead
                  column="condition"
                  label="Condition"
                  active={sortColumn}
                  direction={sortDirection}
                  href={sortHref("condition")}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  // Retired kit recedes rather than disappearing: nothing in
                  // this app is ever deleted, so the row stays and drains its
                  // contrast (DESIGN-SYSTEM §6).
                  className={
                    row.status === "RETIRED" ? "text-muted-foreground" : ""
                  }
                >
                  <TableCell>
                    <AssetTagLink id={row.id} tag={row.tag} />
                  </TableCell>
                  <TableCell>{assetDisplayName(row)}</TableCell>
                  <TableCell>{row.categoryName}</TableCell>
                  <TableCell>
                    <StatusChip status={row.status} />
                  </TableCell>
                  {canSeeHolders ? (
                    <TableCell>
                      {/* Rendered only inside canSeeHolders, so the link can
                            never appear for a viewer /people/[id] would
                            reject. row.holder is null for those viewers
                            anyway — nothing was fetched. */}
                      {row.holder ? (
                        <Link
                          href={`/people/${row.holder.id}`}
                          className="underline underline-offset-4"
                        >
                          {row.holder.name}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell>{row.siteName ?? "—"}</TableCell>
                  <TableCell>
                    {row.condition ? CONDITION_LABELS[row.condition] : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ResponsiveTable>

          {/* Outside the breakpoint pair on purpose: one footer for both
              shapes, so the range a phone reads and the range a desktop reads
              cannot disagree. */}
          <RegisterPager
            page={page}
            pageCount={pageCount}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            total={total}
            hrefForPage={pageHref}
          />
        </>
      )}
    </>
  );
}
