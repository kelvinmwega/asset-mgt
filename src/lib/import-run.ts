import "server-only";
import { createHash } from "node:crypto";
import { AssetStatus, type Prisma, type PrismaClient } from "@prisma/client";
import {
  createHolderResolver,
  importAssetWithEvent,
  withImportLock,
} from "@/lib/asset-import";
import {
  IMPORT_PROBLEMS,
  type ImportProblem,
  type MappedRow,
  type RowProblem,
  foldName,
  mapRow,
  missingHeaders,
} from "@/lib/import-map";

/**
 * The AM-04 import RUN: dry-run and commit, sharing one code path.
 *
 * ONE code path, because two would mean the preview and the write could
 * disagree — the single thing a dry run exists to rule out. A dry run performs
 * every read and every write and then rolls each row back, so it is checked by
 * the REAL constraints (the tag CHECK, the partial unique index on open
 * assignments, every foreign key) rather than by a model of them. A read-only
 * preview would report success for rows the database will later refuse.
 *
 * `commit` reaches three places, not one, and the two beyond the rollback are
 * consequences of it rather than separate behaviour:
 *
 *  1. whether each row's transaction commits or rolls back;
 *  2. whether a newly created Category, Site or stub Person is REMEMBERED for
 *     later rows — on a dry run those rows are rolled back, so caching an id
 *     would hand the next row a foreign key that no longer exists;
 *  3. therefore, that "would create" counts are taken from distinct NAMES
 *     rather than from create events, so a person holding nine assets is
 *     reported once and not nine times.
 *
 * (2) is the subtle one and it is why this note exists: the obvious
 * implementation caches unconditionally, passes every test that imports a
 * single row, and fails on the second row naming the same new person.
 */

type Tx = Prisma.TransactionClient;

/** A parsed sheet, as `import-xlsx.ts` produces it. */
export type ParsedSheet = {
  headers: string[];
  rows: { rowNumber: number; cells: Record<string, string | number> }[];
};

export type RowOutcome =
  | { kind: "imported"; sourceRow: number; tag: string }
  | { kind: "skipped"; sourceRow: number; tag: string }
  | { kind: "conflict"; sourceRow: number; tag: string; fields: string[] }
  | { kind: "quarantined"; sourceRow: number; problem: ImportProblem };

/**
 * The PERSISTED report. NO PERSONAL DATA (advisor condition C6): no name, no
 * email, no employeeRef, and no verbatim echo of a source row.
 *
 * Rows are identified by source row number plus Asset Tag ID; people appear as
 * COUNTS and as `personId`s only — the same join-don't-copy pattern
 * `AssetEvent.assignmentId` exists to enforce. A future surface over this table
 * is ADMIN_IT-only, and holding this line now is what keeps that surface cheap.
 */
export type ImportReport = {
  sourceRowCount: number;
  imported: number;
  skipped: number;
  conflicted: number;
  quarantined: number;
  /** Quarantine counts by reason — the operator's triage list. */
  problems: Record<string, number>;
  /** Reference rows the run would create, by name. Names of PLACES, not people. */
  newCategories: string[];
  newSites: string[];
  holders: {
    matched: number;
    created: number;
    ambiguous: number;
    /**
     * Rows whose `Assigned to` names someone but whose STATUS is not ASSIGNED —
     * the client's own sample row. The legacy register keeps the last assignee after
     * check-in, so the name is history there and state here; carrying it over
     * would fabricate a current assignment and put a named person on the hook
     * for kit they returned. Counted and reported rather than silently dropped
     * (the AC), by ROW NUMBER only — no name reaches the persisted report.
     */
    discarded: number;
  };
  /** Source rows whose assignee was discarded, for the operator to eyeball. */
  discardedHolderRows: number[];
  /** Outcomes, row by row. Carries tags and row numbers, never a person. */
  outcomes: RowOutcome[];
};

export type DryRunResult = {
  report: ImportReport;
  sourceSha256: string;
  rowsHash: string;
  /**
   * Assignee resolutions for the SIGN-OFF list (C9). In-flight only — this is
   * printed for a human and never persisted, which is what lets it carry names
   * while `ImportReport` does not.
   */
  holderSignOff: {
    name: string;
    outcome: "matched" | "created" | "ambiguous";
  }[];
};

/** The file's SHA-256 — catches a swapped file between dry-run and commit. */
export function hashSource(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A hash of the NORMALISED parsed rows.
 *
 * Two hashes rather than one (advisor condition C21), because they catch
 * different substitutions: `sourceSha256` catches a different file, `rowsHash`
 * catches a file that differs only in ways the parser normalises away — resaved
 * in another Excel build, restyled, rows reordered. Together they are what make
 * "the committed data is the previewed data" provable while keeping ZERO
 * server-side parsed state between the two commands.
 */
export function hashRows(sheet: ParsedSheet): string {
  const hash = createHash("sha256");
  for (const row of sheet.rows) {
    // Keys sorted so cell ORDER cannot change the hash — the parser keys by
    // header name, and object insertion order is not part of the data.
    const keys = Object.keys(row.cells).sort();
    // The delimiters below give the hash DOMAIN SEPARATION: without them
    // `{a:"1", b:"2"}` and `{ab:"12"}` feed identical bytes and collide, which
    // would let a swapped file satisfy the C21 binding. Control characters
    // because no cell value can contain one — the parser produces only
    // shared-string text and numbers.
    //
    // WRITTEN AS \u ESCAPES, NEVER AS RAW BYTES, and that is not cosmetic. The
    // first version of this function embedded the literal 0x00-0x03 bytes. A
    // NUL in the first 8 KB makes git classify the file as BINARY — and this
    // module orchestrates every write in the import, so GitHub rendered
    // "Binary file not shown" and no reviewer or diff-based gate could read a
    // line of it. Worse, `rg` answered "binary file matches" instead of the
    // matching line, which silently UNDER-REPORTS the documented
    // person-visibility.ts chokepoint audit: a suppression that fails open.
    //
    // The escapes are byte-identical at runtime. `hashRows` golden-value test
    // in import-run.integration.test.ts pins the digest so this can never be
    // "tidied" into something that changes what is computed — that would break
    // the dry-run/commit binding silently, for every future import.

    hash.update(`${row.rowNumber}\u0000`);
    for (const key of keys) {
      hash.update(`${key}\u0001${String(row.cells[key])}\u0002`);
    }
    hash.update("\u0003");
  }
  return hash.digest("hex");
}

/** Thrown for whole-file problems, which fail the run rather than a row. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

/**
 * The columns compared on a re-run to report a CONFLICT.
 *
 * Insert-only (C20): an existing tag is SKIPPED, never updated. A row whose
 * other fields have changed is reported as a conflict and still not written —
 * because a re-run must not silently revert the twenty descriptions an admin
 * fixed by hand between runs, each with an UPDATED event claiming they made the
 * change.
 */
const CONFLICT_FIELDS = [
  "description",
  "make",
  "model",
  "serial",
  "supplier",
  "poNumber",
  "costCentre",
  "department",
  "location",
] as const satisfies readonly (keyof MappedRow)[];

/**
 * Runs the import.
 *
 * `commit: false` performs every read and every write and then ROLLS BACK, so
 * the dry-run exercises the real constraints — the CHECK on tag, the partial
 * unique index on open assignments, every FK — rather than a model of them. A
 * dry-run that only reads would report success for rows the database will later
 * refuse.
 */
export async function runImport(
  db: PrismaClient,
  sheet: ParsedSheet,
  sourceBytes: Uint8Array,
  options: { commit: boolean },
): Promise<DryRunResult> {
  const missing = missingHeaders(sheet.headers);
  if (missing.length > 0) {
    // A whole-file failure, not 400 identical per-row ones: a header mismatch
    // means we are reading a different export shape entirely.
    throw new ImportFileError(
      `Export is missing ${missing.length} expected column(s): ${missing.join(", ")}`,
    );
  }

  const outcomes: RowOutcome[] = [];
  const problems: Record<string, number> = {};
  const holderSignOff: DryRunResult["holderSignOff"] = [];
  // Distinct people, not distinct rows. On a dry run each row naming a new
  // person creates and rolls back its own stub, so counting events would report
  // one "created" per ASSET they hold rather than one per human.
  const discardedHolderRows: number[] = [];
  const holderNames = {
    matched: new Set<string>(),
    created: new Set<string>(),
    ambiguous: new Set<string>(),
  };
  const newCategories = new Set<string>();
  const newSites = new Set<string>();

  const quarantine = (problem: RowProblem) => {
    outcomes.push({
      kind: "quarantined",
      sourceRow: problem.sourceRow,
      problem: problem.problem,
    });
    problems[problem.problem] = (problems[problem.problem] ?? 0) + 1;
  };

  // Map everything first, so the census and the duplicate check see the whole
  // file before anything is written.
  const mapped: MappedRow[] = [];
  const seenTags = new Map<string, number>();
  for (const row of sheet.rows) {
    const result = mapRow(row.rowNumber, row.cells);
    if (!result.ok) {
      quarantine(result.problem);
      continue;
    }
    // A tag repeated WITHIN the file is a source-data problem, and it must be
    // caught here rather than by the unique index — the index would let the
    // first win and report the second as an ordinary duplicate, which reads as
    // "already imported" when it is not.
    const firstSeen = seenTags.get(result.row.tag);
    if (firstSeen !== undefined) {
      quarantine({
        sourceRow: result.row.sourceRow,
        problem: IMPORT_PROBLEMS.DUPLICATE_TAG_IN_FILE,
        detail: result.row.tag,
      });
      continue;
    }
    seenTags.set(result.row.tag, result.row.sourceRow);
    mapped.push(result.row);
  }

  // DETERMINISTIC ORDER (AM-04-CF-A). Sorted by tag, which is also the
  // idempotency key, so two runs touch rows in the same sequence.
  mapped.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));

  await withImportLock(db, async () => {
    // Built INSIDE the lock: it caches the person table, so a concurrent run
    // creating a stub behind its back would reintroduce the duplicate the lock
    // exists to prevent.
    const resolver = await createHolderResolver(db, foldName, {
      cacheCreations: options.commit,
    });

    const categories = new Map(
      (await db.category.findMany({ select: { id: true, name: true } })).map(
        (row) => [row.name.trim().toLowerCase(), row.id],
      ),
    );
    const sites = new Map(
      (await db.site.findMany({ select: { id: true, name: true } })).map(
        (row) => [row.name.trim().toLowerCase(), row.id],
      ),
    );

    for (const row of mapped) {
      try {
        // ONE TRANSACTION PER ROW (C22). Partial failure leaves N imported and
        // the rest not, which is safe precisely because insert-only idempotency
        // lets a re-run finish the job.
        await db.$transaction(async (tx) => {
          const existing = await tx.asset.findUnique({
            where: { tag: row.tag },
            select: {
              description: true,
              make: true,
              model: true,
              serial: true,
              supplier: true,
              poNumber: true,
              costCentre: true,
              department: true,
              location: true,
            },
          });

          if (existing) {
            // No `?? null` on either side: every CONFLICT_FIELDS entry is
            // `string | null` on MappedRow AND on the Prisma select above, so
            // neither can be `undefined` and both coalesces were dead code.
            // Dead code beats an ignore directive — an unreachable branch reads
            // as "a nullish case exists here" to the next person.
            const changed = CONFLICT_FIELDS.filter(
              (field) => existing[field] !== row[field],
            );
            outcomes.push(
              changed.length === 0
                ? { kind: "skipped", sourceRow: row.sourceRow, tag: row.tag }
                : {
                    kind: "conflict",
                    sourceRow: row.sourceRow,
                    tag: row.tag,
                    // FIELD NAMES ONLY — `description` may contain a person's
                    // name, and this list is persisted.
                    fields: [...changed],
                  },
            );
            return;
          }

          const categoryId = await resolveReference(
            tx,
            "category",
            categories,
            row.categoryName,
            newCategories,
            options.commit,
          );
          const siteId =
            row.siteName === null
              ? null
              : await resolveReference(
                  tx,
                  "site",
                  sites,
                  row.siteName,
                  newSites,
                  options.commit,
                );

          let holder: { personId: string; checkedOutAt: Date } | null = null;
          // AN OPEN ASSIGNMENT IS CREATED IF AND ONLY IF THE MAPPED STATUS IS
          // ASSIGNED (advisor condition C44). Both halves of the README
          // reconciliation query hang off this one predicate: an open
          // assignment on a non-ASSIGNED asset is `strandedOpen`, and an
          // ASSIGNED asset with none is `strandedAssigned`. Neither is
          // correctable afterwards without fabricating a return.
          //
          // The mapper already quarantines the ASSIGNED-with-no-holder half, so
          // what remains here is the other one: a name on a row that is not
          // assigned. It is DISCARDED AND REPORTED, never carried over.
          if (
            row.assigneeName !== null &&
            row.status !== AssetStatus.ASSIGNED
          ) {
            discardedHolderRows.push(row.sourceRow);
          }
          if (row.status === AssetStatus.ASSIGNED && row.assigneeName) {
            const resolution = await resolver.resolve(tx, row.assigneeName);
            if (resolution.kind === "ambiguous") {
              holderNames.ambiguous.add(foldName(row.assigneeName));
              holderSignOff.push({
                name: row.assigneeName,
                outcome: "ambiguous",
              });
              // Quarantine INSIDE the transaction by throwing: the stub person
              // this row may already have created must roll back with it.
              throw new RowQuarantine(IMPORT_PROBLEMS.AMBIGUOUS_HOLDER);
            }
            holderNames[resolution.kind].add(foldName(row.assigneeName));
            holderSignOff.push({
              name: row.assigneeName,
              outcome: resolution.kind,
            });
            holder = {
              personId: resolution.personId,
              // The source has no handover date — only `Purchase Date`. Using
              // it is the honest choice: it is the earliest moment the asset
              // could have been held, and it is demonstrably not "today".
              // Falling back to the import moment for a row with no purchase
              // date is visible in the history as the cutover date rather than
              // masquerading as a real handover.
              checkedOutAt: row.purchasedAt ?? new Date(),
            };
          }

          await importAssetWithEvent(tx, {
            tag: row.tag,
            categoryId,
            siteId,
            status: row.status,
            description: row.description,
            make: row.make,
            model: row.model,
            serial: row.serial,
            supplier: row.supplier,
            purchasedAt: row.purchasedAt,
            purchasePrice: row.purchasePrice,
            poNumber: row.poNumber,
            costCentre: row.costCentre,
            department: row.department,
            location: row.location,
            holder,
          });

          outcomes.push({
            kind: "imported",
            sourceRow: row.sourceRow,
            tag: row.tag,
          });

          if (!options.commit) {
            // THE ONLY DIFFERENCE between dry-run and commit. Every read and
            // every write above has already happened against real constraints;
            // this throws them away.
            throw new DryRunRollback();
          }
        });
      } catch (error) {
        if (error instanceof DryRunRollback) continue;
        if (error instanceof RowQuarantine) {
          quarantine({ sourceRow: row.sourceRow, problem: error.problem });
          continue;
        }
        throw error;
      }
    }
  });

  const counts = outcomes.reduce(
    (acc, outcome) => ({
      ...acc,
      [outcome.kind]: (acc[outcome.kind] ?? 0) + 1,
    }),
    {} as Record<string, number>,
  );

  return {
    sourceSha256: hashSource(sourceBytes),
    rowsHash: hashRows(sheet),
    holderSignOff,
    report: {
      sourceRowCount: sheet.rows.length,
      imported: counts.imported ?? 0,
      skipped: counts.skipped ?? 0,
      conflicted: counts.conflict ?? 0,
      quarantined: counts.quarantined ?? 0,
      problems,
      newCategories: [...newCategories].sort(),
      newSites: [...newSites].sort(),
      holders: {
        matched: holderNames.matched.size,
        created: holderNames.created.size,
        ambiguous: holderNames.ambiguous.size,
        discarded: discardedHolderRows.length,
      },
      discardedHolderRows,
      outcomes,
    },
  };
}

/** Rolls a dry-run's per-row transaction back. Never escapes `runImport`. */
class DryRunRollback extends Error {}

/** Quarantines a row from inside its transaction, discarding partial writes. */
class RowQuarantine extends Error {
  readonly problem: ImportProblem;
  constructor(problem: ImportProblem) {
    super(problem);
    this.problem = problem;
  }
}

/**
 * Find a Category or Site by name, creating it when absent.
 *
 * Case-insensitive matching against existing rows, because "Docking Station"
 * and "DOCKING STATION" are one category and creating both would split the
 * register permanently — reference rows are renamed, never removed, and a
 * rename CANNOT MERGE.
 *
 * Creation is gated by the operator, not by this function: the dry-run's census
 * lists every name that would be created and `--commit` runs only after a human
 * has signed it (advisor condition C16). This is the second of the story's two
 * one-way doors.
 */
async function resolveReference(
  tx: Tx,
  kind: "category" | "site",
  cache: Map<string, string>,
  name: string,
  created: Set<string>,
  cacheCreations: boolean,
): Promise<string> {
  const key = name.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const row =
    kind === "category"
      ? await tx.category.create({ data: { name }, select: { id: true } })
      : await tx.site.create({ data: { name }, select: { id: true } });
  // Only when the row will really survive. On a dry run this transaction is
  // rolled back, so caching the id would hand the next row a category that no
  // longer exists and the asset insert would fail on the foreign key. `created`
  // is keyed by NAME, so the census stays correct either way.
  if (cacheCreations) {
    cache.set(key, row.id);
  }
  created.add(name);
  return row.id;
}
