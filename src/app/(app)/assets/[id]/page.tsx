import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Role,
  type AssetEventType,
  type AssetStatus,
  type Prisma,
  type PrismaClient,
} from "@prisma/client";
import { ASSET_TRANSITIONS } from "@/lib/asset-lifecycle";
import { assetDisplayName } from "@/lib/asset-display";
import { requireRole } from "@/lib/authz";
import { calendarDate, calendarDateInputValue } from "@/lib/calendar-date";
import { CONDITION_LABELS } from "@/lib/labels";
import { getDb } from "@/lib/db";
import { canViewAssignments, personSelectFor } from "@/lib/person-visibility";
import {
  ResponsiveTable,
  SCROLL_PANE,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/relative-time";
import { AssignmentCardList } from "@/components/assignment-card-list";
import { Timestamp } from "@/components/timestamp";
import { SectionHeading } from "@/components/section-heading";
import { StatusChip } from "@/components/ui/status-chip";
import { AssetForm } from "../asset-form";
import { EditDetails } from "./edit-details";
import { HistoryTimeline } from "./history-timeline";
import type { PickerPerson, ReturnDestination } from "./assignment-actions";
import { LifecycleActions, type LifecycleMove } from "./lifecycle-actions";

/**
 * The moves offered from a status, derived from the single transition map so
 * there is never a second source of truth about what is legal.
 *
 * The one place the map alone is not enough: out of ASSIGNED, IN_STOCK and
 * IN_REPAIR are BOTH reached by taking the asset back from its holder. So
 * ASSIGNED offers no "send to repair" button — a repair-bound return is the
 * return action with toStatus=IN_REPAIR, which keeps closing the assignment and
 * changing the status in one transaction and one event (AM-03 DESIGN §4.2).
 * Retire stays available: the write layer closes the assignment itself, and
 * stolen kit must be retirable without recording a fictional return.
 */
function lifecycleMovesFor(status: AssetStatus): LifecycleMove[] {
  const allowed = ASSET_TRANSITIONS[status];
  const moves: LifecycleMove[] = [];
  if (status === "ON_ORDER" && allowed.includes("IN_STOCK")) {
    moves.push("RECEIVE");
  }
  if (allowed.includes("ASSIGNED")) {
    moves.push("ASSIGN");
  }
  if (status === "ASSIGNED") {
    if (allowed.includes("IN_STOCK") || allowed.includes("IN_REPAIR")) {
      moves.push("RETURN_FROM_PERSON");
    }
  } else {
    if (status === "IN_REPAIR" && allowed.includes("IN_STOCK")) {
      moves.push("RETURN");
    }
    if (allowed.includes("IN_REPAIR")) {
      moves.push("SEND_TO_REPAIR");
    }
  }
  if (allowed.includes("RETIRED")) {
    moves.push("RETIRE");
  }
  return moves;
}

/** The return form's destination options, from the same transition map. */
const RETURN_DESTINATIONS: readonly ReturnDestination[] = [
  "IN_STOCK",
  "IN_REPAIR",
];

function returnDestinationsFor(status: AssetStatus): ReturnDestination[] {
  return RETURN_DESTINATIONS.filter((destination) =>
    ASSET_TRANSITIONS[status].includes(destination),
  );
}

/**
 * A date to read, not to re-enter. `calendarDateInputValue`'s YYYY-MM-DD is the
 * format an <input type="date"> requires and it leaked into the display grid,
 * where "2026-06-21" is worse than "21 Jun 2026" for the one job it has.
 *
 * The rule itself — that these two fields are calendar dates and are pinned to
 * UTC whoever is reading — moved to `@/lib/calendar-date` in AM-10, when every
 * other timestamp on this page started moving with the viewer. Both wrappers
 * are null-handling only; the formatting decisions live in that module and its
 * tests.
 */
function toDateInput(value: Date | null): string {
  return value ? calendarDateInputValue(value) : "";
}

function toDisplayDate(value: Date | null): string | null {
  return value ? calendarDate(value) : null;
}

/**
 * Money, grouped and to two places — but with no currency symbol, because the
 * schema does not record one. `Asset.purchasePrice` is a bare Decimal, so
 * printing "KES" here would be the UI inventing a fact the data does not hold.
 * Grouping is the honest half of the improvement: 120750 vs 120,750.00.
 */
function toDisplayPrice(value: string): string | null {
  if (!value) return null;
  const amount = Number(value);
  return Number.isFinite(amount)
    ? amount.toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : value;
}

/**
 * What the history's "Who" column shows when there is no name to show.
 *
 * `System` means the event genuinely has no actor (the seed script). `IT` is
 * the neutral label for an actor this viewer may not be told about — either a
 * STAFF_RO viewer, for whom the actor is not selected at all, or an actor whose
 * account has no name and whose email this viewer's role does not include.
 */
const SYSTEM_ACTOR_LABEL = "System";
const IT_ACTOR_LABEL = "IT";

type HistoryRow = {
  id: string;
  at: Date;
  type: AssetEventType;
  fromStatus: AssetStatus | null;
  toStatus: AssetStatus | null;
  notes: string | null;
  who: string;
};

const EVENT_FIELDS = {
  id: true,
  at: true,
  type: true,
  fromStatus: true,
  toStatus: true,
  notes: true,
} as const;

function whoLabel(actor: { name: string | null; email?: string } | null) {
  if (actor === null) return SYSTEM_ACTOR_LABEL;
  return actor.name ?? actor.email ?? IT_ACTOR_LABEL;
}

/**
 * The status history, with actor identity tiered exactly as person data is
 * (AM-03 DESIGN §5.3, advisor condition 11 — this closes a live leak on main,
 * where `name ?? email` was rendered for all four roles and any actor without a
 * name exposed their email address to every staff user).
 *
 * Three query branches rather than one query with `email: role === ADMIN_IT`:
 * Prisma types a boolean-valued select field as PRESENT whatever the boolean
 * turns out to be, so that shape reads as "email is always here" and only the
 * runtime disagrees. Written out, the ONE branch selecting an email is the one
 * guarded by an ADMIN_IT check, and review can see it without trusting a type.
 *
 * A STAFF_RO viewer still sees the whole history — they just see no person on
 * it, because none is fetched.
 */
async function historyFor(
  db: PrismaClient,
  assetId: string,
  role: Role,
): Promise<HistoryRow[]> {
  // Newest first. TIMESTAMP(3) can tie for events written milliseconds apart;
  // cuid is monotonic, so it is the stable tie-breaker.
  const query = {
    where: { assetId },
    orderBy: [{ at: "desc" }, { id: "desc" }],
  } satisfies Prisma.AssetEventFindManyArgs;

  if (!canViewAssignments(role)) {
    const events = await db.assetEvent.findMany({
      ...query,
      select: EVENT_FIELDS,
    });
    return events.map((event) => ({ ...event, who: IT_ACTOR_LABEL }));
  }

  if (role === Role.ADMIN_IT) {
    const events = await db.assetEvent.findMany({
      ...query,
      select: {
        ...EVENT_FIELDS,
        actor: { select: { name: true, email: true } },
      },
    });
    return events.map(({ actor, ...event }) => ({
      ...event,
      who: whoLabel(actor),
    }));
  }

  const events = await db.assetEvent.findMany({
    ...query,
    select: { ...EVENT_FIELDS, actor: { select: { name: true } } },
  });
  return events.map(({ actor, ...event }) => ({
    ...event,
    who: whoLabel(actor),
  }));
}

export default async function AssetDetailPage({
  params,
}: {
  // Async in Next 15 — a non-async signature typechecks and fails the build.
  params: Promise<{ id: string }>;
}) {
  const { role } = await requireRole(
    "ADMIN_IT",
    "PROCUREMENT",
    "FINANCE",
    "STAFF_RO",
  );
  const canWrite = role === "ADMIN_IT" || role === "PROCUREMENT";
  // THE gate for every person-shaped read on this page (advisor condition 9).
  // It is checked BEFORE each query, never in the JSX: a STAFF_RO viewer's page
  // does not fetch the assignment or the person, so no later UI change can leak
  // what was never loaded.
  const canSeeHolders = canViewAssignments(role);
  const { id } = await params;

  const db = getDb();
  const asset = await db.asset.findUnique({
    where: { id },
    include: { category: true, site: true },
  });
  if (!asset) {
    notFound();
  }

  const moves = lifecycleMovesFor(asset.status);
  const [history, categories, sites] = await Promise.all([
    historyFor(db, asset.id, role),
    db.category.findMany({ orderBy: { name: "asc" } }),
    db.site.findMany({ orderBy: { name: "asc" } }),
  ]);

  // Every holder this asset has ever had, newest first; the open one (at most
  // one, by the partial unique index) is the current holder.
  const assignments = canSeeHolders
    ? await db.assignment.findMany({
        where: { assetId: asset.id },
        orderBy: [{ checkedOutAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          checkedOutAt: true,
          returnedAt: true,
          conditionNotes: true,
          person: { select: personSelectFor(role) },
        },
      })
    : [];
  const holder = assignments.find((row) => row.returnedAt === null) ?? null;

  // Only fetched when the assign form will actually render — the picker is the
  // one place this page loads people who have nothing to do with this asset.
  const people: PickerPerson[] =
    canWrite && moves.includes("ASSIGN")
      ? (
          await db.person.findMany({
            orderBy: { name: "asc" },
            select: personSelectFor(role),
          })
        ).map((person) => ({
          id: person.id,
          name: person.name,
          // Email is deliberately dropped rather than passed and unused: the
          // picker disambiguates by employeeRef, and nothing that crosses to
          // the client needs an address.
          employeeRef: person.employeeRef,
        }))
      : [];

  // Prisma's Decimal is not serialisable across the server/client boundary —
  // convert before it reaches any client component.
  const purchasePrice = asset.purchasePrice?.toString() ?? "";

  // One clock for the whole page: two entries disagreeing about "now" is a
  // real bug, and it only appears when the render straddles a boundary.
  const now = new Date();

  // An empty optional reads "Not recorded", never an em-dash. A dash is what a
  // broken renderer produces; the words say the field is genuinely blank, which
  // for purchase data is information finance acts on.
  const detailFields = (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      <Field label="Category" value={asset.category.name} />
      <Field label="Serial" value={asset.serial} mono />
      <Field label="Site" value={asset.site?.name ?? null} />
      <Field
        label="Condition"
        value={asset.condition ? CONDITION_LABELS[asset.condition] : null}
      />
      <Field label="Supplier" value={asset.supplier} />
      <Field label="Purchased" value={toDisplayDate(asset.purchasedAt)} />
      <Field
        label="Purchase price"
        value={toDisplayPrice(purchasePrice)}
        mono
      />
      <Field
        label="Warranty until"
        value={toDisplayDate(asset.warrantyUntil)}
      />
    </dl>
  );

  return (
    <>
      {/* Somewhere to go back to. The detail page had no route out except the
          rail, which is a dead end on a phone. */}
      <nav className="text-muted-foreground -mb-2 text-sm">
        <Link href="/assets" className="underline underline-offset-4">
          Register
        </Link>
        <span aria-hidden="true"> › </span>
        <span>{asset.tag ?? "Untagged"}</span>
      </nav>

      {/* The tag is this page's proper noun, and the status is the one fact
          that changes what you can do next — so they lead, together. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
          {asset.tag ?? "Untagged asset"}
        </h1>
        <StatusChip status={asset.status} />
        <p className="text-muted-foreground w-full text-sm">
          {assetDisplayName(asset)} · {asset.category.name}
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-8">
          {canSeeHolders ? (
            <section className="flex flex-col gap-3">
              <SectionHeading>Custody</SectionHeading>
              {/* Out of the field grid, where it was the eleventh of eleven
                  entries, and into the page's second element: "who has this"
                  is the question the register exists to answer. */}
              {holder ? (
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <span
                    aria-hidden="true"
                    className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold"
                  >
                    {initials(holder.person.name)}
                  </span>
                  <span className="min-w-0">
                    <Link
                      href={`/people/${holder.person.id}`}
                      className="font-medium underline underline-offset-4"
                    >
                      {holder.person.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs">
                      {[
                        holder.person.employeeRef,
                        `held ${relativeTime(holder.checkedOutAt, now).replace(" ago", "")}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Not with anyone right now.
                </p>
              )}
            </section>
          ) : null}

          {canWrite ? (
            /* Rendered for write roles only — but that is UX. requireRole
               inside each action is what enforces it. */
            <section className="flex flex-col gap-3">
              <SectionHeading>Lifecycle</SectionHeading>
              <LifecycleActions
                assetId={asset.id}
                moves={moves}
                people={people}
                returnDestinations={returnDestinationsFor(asset.status)}
              />
            </section>
          ) : null}

          {canWrite ? (
            <EditDetails summary={detailFields}>
              <AssetForm
                categories={categories}
                sites={sites}
                asset={{
                  id: asset.id,
                  tag: asset.tag ?? "",
                  categoryId: asset.categoryId,
                  // ?? "" like every other nullable field below: the form's
                  // inputs are controlled and a null value would make them
                  // uncontrolled. Imported assets have neither (AM-04).
                  make: asset.make ?? "",
                  model: asset.model ?? "",
                  description: asset.description ?? "",
                  serial: asset.serial ?? "",
                  purchasedAt: toDateInput(asset.purchasedAt),
                  purchasePrice,
                  supplier: asset.supplier ?? "",
                  warrantyUntil: toDateInput(asset.warrantyUntil),
                  condition: asset.condition ?? "",
                  siteId: asset.siteId ?? "",
                  poNumber: asset.poNumber ?? "",
                  costCentre: asset.costCentre ?? "",
                  department: asset.department ?? "",
                  location: asset.location ?? "",
                }}
              />
            </EditDetails>
          ) : (
            <section className="flex flex-col gap-3">
              <SectionHeading>Details</SectionHeading>
              {detailFields}
            </section>
          )}
        </div>

        <section className="flex min-w-0 flex-col gap-3 lg:border-l lg:pl-8">
          <SectionHeading count={history.length}>History</SectionHeading>
          <HistoryTimeline entries={history} now={now} />
          <p className="text-muted-foreground text-xs">
            Append-only. Corrections are new entries.
          </p>
        </section>
      </div>

      {canSeeHolders ? (
        <section className="flex flex-col gap-3">
          <SectionHeading>Every holder</SectionHeading>
          {assignments.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This asset has never been assigned.
            </p>
          ) : (
            <ResponsiveTable
              tableTestId="holders-table"
              cardsTestId="holders-cards"
              cards={
                <AssignmentCardList
                  subject="person"
                  rows={assignments}
                  label="Everyone who has held this asset"
                />
              }
              // Unbounded — an asset accumulates holders for its whole life —
              // and sitting at the foot of the page, so it gets a scroll pane
              // and the sticky header that pane makes possible.
              sticky
              containerClassName={SCROLL_PANE}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Employee ref</TableHead>
                  <TableHead>Checked out</TableHead>
                  <TableHead>Returned</TableHead>
                  <TableHead>Condition note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments.map((assignment) => (
                  <TableRow key={assignment.id}>
                    <TableCell>
                      {/* The only route to /people/[id]. Rendered solely inside
                          this canSeeHolders branch, so the link cannot appear
                          for a viewer the route would reject anyway. */}
                      <Link
                        href={`/people/${assignment.person.id}`}
                        className="underline underline-offset-4"
                      >
                        {assignment.person.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {assignment.person.employeeRef ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Timestamp value={assignment.checkedOutAt} exact />
                    </TableCell>
                    <TableCell>
                      {assignment.returnedAt ? (
                        <Timestamp value={assignment.returnedAt} exact />
                      ) : (
                        // A fact, not an empty cell — this table mixes open and
                        // closed assignments, so "—" would be wrong here.
                        "Still held"
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {assignment.conditionNotes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ResponsiveTable>
          )}
        </section>
      ) : null}
    </>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  /** Identifiers and figures, which want tabular digits and a fixed advance. */
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd
        className={
          value
            ? mono
              ? "font-mono text-sm tabular-nums"
              : undefined
            : "text-muted-foreground"
        }
      >
        {value ? value : "Not recorded"}
      </dd>
    </div>
  );
}

/** Up to two initials, for the custody avatar. Decorative and aria-hidden. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
