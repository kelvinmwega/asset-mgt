import { notFound } from "next/navigation";
import { assetDisplayName } from "@/lib/asset-display";
import { requireRole } from "@/lib/authz";
import { AssetTagLink } from "@/components/asset-tag-link";
import { AssignmentCardList } from "@/components/assignment-card-list";
import { SectionHeading } from "@/components/section-heading";
import { Timestamp } from "@/components/timestamp";
import { StatusChip } from "@/components/ui/status-chip";
import {
  ResponsiveTable,
  SCROLL_PANE,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeactivatedNotice } from "./deactivated-notice";
import { fetchPersonView, type PersonAssignmentRow } from "./person-view";

/**
 * The per-person view (AM-03 DESIGN §5.1). The role gate is the whole guard:
 * enumerable cuids are not a vulnerability when every reader of this route is
 * authorised by role to read every person, so no obfuscation is added here.
 * `STAFF_RO` is absent from the gate deliberately — a read-only staff user
 * sees no person's assignment data anywhere except their own
 * /me/assignments (DESIGN §2.1).
 *
 * Which FIELDS a viewer sees is decided in the Prisma `select` by
 * `personSelectFor`, never by rendering less here: the conditionals below
 * render what was fetched, and for a PROCUREMENT or FINANCE viewer the email
 * never left the database.
 */

export default async function PersonPage({
  params,
}: {
  // Async in Next 15 — a non-async signature typechecks and fails the build.
  params: Promise<{ id: string }>;
}) {
  const { role } = await requireRole("ADMIN_IT", "PROCUREMENT", "FINANCE");
  const { id } = await params;

  const view = await fetchPersonView(role, id);
  if (!view) {
    notFound();
  }
  const { person, deactivatedAt, open, past } = view;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{person.name}</h1>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
        {person.employeeRef !== undefined ? (
          <Field label="Employee ref" value={person.employeeRef} />
        ) : null}
        {person.email !== undefined ? (
          <Field label="Email" value={person.email} />
        ) : null}
      </dl>

      {deactivatedAt !== null ? (
        // Why this sentence is its own client component — and why it is not a
        // <Timestamp> — is documented on DeactivatedNotice itself.
        <DeactivatedNotice deactivatedAt={deactivatedAt} />
      ) : null}

      <section className="flex flex-col gap-4">
        <SectionHeading>Currently held</SectionHeading>
        {open.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            This person is not holding any assets.
          </p>
        ) : (
          // No `sticky`: what one person holds right now is a short list.
          <ResponsiveTable
            tableTestId="held-table"
            cardsTestId="held-cards"
            cards={
              <AssignmentCardList
                subject="asset"
                rows={open}
                label="Assets this person is holding"
              />
            }
          >
            <TableHeader>
              <TableRow>
                <TableHead>Tag</TableHead>
                <TableHead>Make / model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Checked out</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {open.map((assignment) => (
                <TableRow key={assignment.id}>
                  <AssetCells assignment={assignment} />
                  <TableCell>
                    <Timestamp value={assignment.checkedOutAt} exact />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ResponsiveTable>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading>Previously held</SectionHeading>
        {past.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing has been returned by this person yet.
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">
              Status is the asset&apos;s status now, not its status at the time
              it was returned.
            </p>
            {/* Unbounded and sitting below other content, so it gets a scroll
                pane and a sticky header — the two are coupled, since a wrapper
                with no bounded height never scrolls for a header to stick
                within. */}
            <ResponsiveTable
              tableTestId="past-table"
              cardsTestId="past-cards"
              cards={
                <AssignmentCardList
                  subject="asset"
                  rows={past}
                  label="Assets this person has returned"
                />
              }
              sticky
              containerClassName={SCROLL_PANE}
            >
              <TableHeader>
                <TableRow>
                  <TableHead>Tag</TableHead>
                  <TableHead>Make / model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Checked out</TableHead>
                  <TableHead>Returned</TableHead>
                  <TableHead>Condition note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {past.map((assignment) => (
                  <TableRow key={assignment.id}>
                    <AssetCells assignment={assignment} />
                    <TableCell>
                      <Timestamp value={assignment.checkedOutAt} exact />
                    </TableCell>
                    <TableCell>
                      {/* No `: "—"` fallback — this table's `where` is
                          `returnedAt: { not: null }`, so the null branch was
                          unreachable. */}
                      {assignment.returnedAt ? (
                        <Timestamp value={assignment.returnedAt} exact />
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {assignment.conditionNotes ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ResponsiveTable>
          </>
        )}
      </section>
    </>
  );
}

/** The three columns both tables open with. */
function AssetCells({ assignment }: { assignment: PersonAssignmentRow }) {
  return (
    <>
      <TableCell>
        <AssetTagLink id={assignment.asset.id} tag={assignment.asset.tag} />
      </TableCell>
      <TableCell>{assetDisplayName(assignment.asset)}</TableCell>
      <TableCell>
        <StatusChip status={assignment.asset.status} />
      </TableCell>
    </>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    // `min-w-0` because a grid item defaults to `min-width: auto` and so
    // refuses to shrink below its content, and `break-all` because an email is
    // one unbreakable token. Without the pair, a long address pushed this grid
    // 21px past its column and gave the whole page a sideways scroll on a
    // phone — measured at 390px, where nothing was POSITIONED off-screen and
    // only the document's scrollWidth gave it away.
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-all">{value ? value : "—"}</dd>
    </div>
  );
}
