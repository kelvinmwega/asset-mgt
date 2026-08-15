import { AssetStatus } from "@prisma/client";

/**
 * THE legacy-export row mapper (AM-04 DESIGN §2, §4).
 *
 * Takes one parsed spreadsheet row — cells keyed by HEADER NAME, values already
 * resolved to strings and numbers by `import-xlsx.ts` — and produces either a
 * row ready to write or a QUARANTINE with a reason.
 *
 * Pure: no database, no `server-only`. Every reference lookup that needs the
 * database (does this Category exist, which Person is this name) happens in the
 * runner, because those decisions need a transaction and this file needs to be
 * unit-testable against the trap table without one.
 *
 * ## Quarantine, not fail-the-run
 *
 * A bad row is quarantined and reported; it never aborts the batch and it is
 * never silently defaulted (advisor conditions C15, C12, C14). With ~400 rows,
 * fail-fast means one unmappable row blocks 399 and the operator's remedy is
 * editing the spreadsheet — which destroys the source↔register correspondence
 * the reconciliation depends on. Silently defaulting is worse still: it misfiles
 * assets into a register the client is about to trust as their only system of
 * record.
 *
 * The AC is "unmapped rows are reported, never silently dropped". Quarantine is
 * how that is implemented: every rejection carries the source row number and
 * the offending value.
 */

/**
 * The export's 21 columns, in the order the legacy register writes them.
 *
 * Used to VALIDATE the header row, never to address cells — cells are addressed
 * by name because the real file is sparse (columns with no `<c>` element at
 * all), so an index-based read misaligns the moment a blank column appears
 * (advisor condition C14). The order here is documentation and a whole-file
 * sanity check, not an access path.
 */
export const EXPECTED_HEADERS = [
  "Asset Tag ID",
  "Description",
  "Purchased from",
  "Purchase Date",
  "Brand",
  "Cost",
  "Model",
  "Serial No",
  "PID",
  "Asset Type",
  "City/Station",
  "CC",
  "P.O Number",
  "Site",
  "Location",
  "Category",
  "Department",
  "Assigned to",
  "Date Created",
  "Created by",
  "Status",
] as const;

/**
 * Columns deliberately not imported ANYWHERE, including into the batch report.
 *
 * `Created by` is a person's name and `Date Created` is "when someone typed
 * this row in 2024". Neither answers a question the register is asked. Parking
 * them in `ImportBatch.report` looked like the safe alternative to
 * `AssetEvent.notes` and is worse: a code-written copy of staff names in a
 * table with no role gate, no retention policy and a blanket no-delete rule
 * (advisor condition C7).
 *
 * `PID` and `Asset Type` are dropped for a different reason — nobody can state
 * what the code "CE" means, and a column holding an unexplained value gets
 * rendered, exported and depended upon (C4, revisited by C31 once the full
 * export's census is in).
 */
export const UNIMPORTED_COLUMNS = [
  "PID",
  "Asset Type",
  "Date Created",
  "Created by",
] as const;

/** Why a row was quarantined. The report groups by this. */
export const IMPORT_PROBLEMS = {
  NO_TAG: "no-tag",
  UNKNOWN_STATUS: "unknown-status",
  NO_CATEGORY: "no-category",
  BAD_DATE: "bad-date",
  BAD_PRICE: "bad-price",
  ASSIGNED_WITHOUT_HOLDER: "assigned-without-holder",
  AMBIGUOUS_HOLDER: "ambiguous-holder",
  DUPLICATE_TAG_IN_FILE: "duplicate-tag-in-file",
} as const;

export type ImportProblem =
  (typeof IMPORT_PROBLEMS)[keyof typeof IMPORT_PROBLEMS];

export type RowProblem = {
  sourceRow: number;
  problem: ImportProblem;
  /**
   * The offending VALUE, never the whole row. The report is persisted to
   * `ImportBatch.report`, which carries no personal data (C6) — a verbatim row
   * echo would put the `Assigned to` name straight into it.
   *
   * The two holder problems therefore carry no detail at all: naming the
   * ambiguous person is exactly the copy this rule exists to prevent. The
   * source row number is enough to find it in the operator's own spreadsheet.
   */
  detail?: string;
};

/** A row that mapped cleanly. Reference names are resolved by the runner. */
export type MappedRow = {
  sourceRow: number;
  tag: string;
  description: string | null;
  make: string | null;
  model: string | null;
  serial: string | null;
  supplier: string | null;
  purchasedAt: Date | null;
  /** A decimal STRING, never a JS number — see `parseMoney`. */
  purchasePrice: string | null;
  poNumber: string | null;
  costCentre: string | null;
  department: string | null;
  location: string | null;
  categoryName: string;
  siteName: string | null;
  assigneeName: string | null;
  status: AssetStatus;
};

export type MapResult =
  { ok: true; row: MappedRow } | { ok: false; problem: RowProblem };

/**
 * The legacy register's status vocabulary → ours.
 *
 * A TOTAL lookup with an explicit undefined branch, never a `switch` with a
 * permissive default (advisor condition C15). Only `Available` is evidenced by
 * the client's file; the rest are the legacy register's documented vocabulary and must
 * be confirmed against the full export before cutover (C18).
 *
 * `Lost` / `Missing` / `Stolen` are DELIBERATELY ABSENT and must not be added
 * as `RETIRED`. Retired means disposed of deliberately; a stolen laptop filed
 * as retired stops being chased. They quarantine instead, which surfaces the
 * question with data attached. Adding a sixth AssetStatus is not a small
 * change — it touches ASSET_TRANSITIONS (5×5 → 6×6), tagRequiredFor, the CHECK
 * constraint's exemptions, every status filter, and a chip palette already at
 * its CVD limit at five hues.
 */
const STATUS_MAP: Readonly<Record<string, AssetStatus>> = {
  available: AssetStatus.IN_STOCK,
  "checked out": AssetStatus.ASSIGNED,
  "under repair": AssetStatus.IN_REPAIR,
  "in repair": AssetStatus.IN_REPAIR,
  disposed: AssetStatus.RETIRED,
  retired: AssetStatus.RETIRED,
  sold: AssetStatus.RETIRED,
  "on order": AssetStatus.ON_ORDER,
};

/**
 * Excel's serial-date epoch. 1899-12-30, not 1900-01-01: Excel deliberately
 * reproduces Lotus 1-2-3's bug of treating 1900 as a leap year, so counting
 * from the 30th is what makes real dates land correctly.
 *
 * Verified against the client's file: serial 45177 → 2023-09-08.
 *
 * `date1904` would shift every date by 1462 days. The PARSER rejects the whole
 * file if that flag is set (C36), which is why this constant can be a constant.
 */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * A serial Excel could plausibly have written, as a sanity range rather than a
 * type check. Below 1 is nonsense; above ~2160-01-01 means the column holds
 * something that is not a date at all.
 */
const MIN_SERIAL = 1;
const MAX_SERIAL = 95_000;

/** Trim, and treat blank as absent. `''` is not a value — it is a missing one. */
export function blankToNull(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Fold a person's name for matching: case-insensitive, whitespace-collapsed.
 *
 * Matching only — the STORED name keeps its original spelling and spacing. A
 * register that renamed people to their fold key would be worse than one that
 * matched strictly.
 */
export function foldName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * An Excel serial number → a UTC Date.
 *
 * The NUMERIC serial is the canonical date form (advisor condition C12), and a
 * STRING date is refused rather than guessed. That asymmetry is the whole point:
 * the client's file carries `Purchase Date` as the bare serial 45177 and
 * `Date Created` as the string "07/29/2024 07:08 AM" — two encodings in one
 * file. The serial is unambiguous; "07/29/2024" is month-first only if you
 * already know it came from a US-locale export, and read day-first it is either
 * invalid or, worse, a different real date.
 *
 * This is also why the parser reads the XLSX directly rather than asking the
 * operator for a CSV: Save-As-CSV renders 45177 through its number format as
 * "09/08/2023" — 8 September, which reads as 9 August to everyone in Nairobi.
 */
export function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial)) return null;
  // Excel writes whole days for a date cell; a fractional part is a time of
  // day. Floor rather than reject: a purchase date with a stray time component
  // is still a purchase date, and the register stores dates at UTC midnight.
  const days = Math.floor(serial);
  if (days < MIN_SERIAL || days > MAX_SERIAL) return null;
  return new Date(EXCEL_EPOCH_UTC + days * MS_PER_DAY);
}

/**
 * A money cell → a decimal STRING, or null when the cell is blank.
 * Returns `undefined` when the value is present but unparseable (quarantine).
 *
 * NEVER `Number()` or `parseFloat` (advisor condition C13). `parseFloat`
 * ("1,229.81") returns 1 — a silent 1000× error in a finance field, on a column
 * `AM-05`'s finance export is built on. A strict regex refuses rather than
 * truncates.
 *
 * Returned as a string because the destination is `Decimal(12,2)`: routing a
 * price through a JS float is how 229.81 becomes 229.80999999999997. Prisma
 * accepts a string for a Decimal column and stores it exactly.
 *
 * NOTE the currency is UNCONFIRMED. In the client's file this arrives as a TEXT
 * cell styled `\$0.00` — dollars — in a Kenyan organisation, against a
 * `purchasePrice` column that records no currency at all. C13 requires that in
 * writing before cutover; if it is mixed, that is a schema change and a new
 * advisor consult.
 */
export function parseMoney(
  value: string | number | undefined,
): string | null | undefined {
  const raw = blankToNull(value);
  if (raw === null) return null;
  // Thousands separators are refused, not stripped. Stripping them means
  // guessing whether "1,229" is one thousand two hundred or a locale writing
  // 1.229 — and the wrong guess is a 1000× error nobody sees.
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return undefined;
  return raw;
}

/** The status cell → our enum. `undefined` means quarantine (C15). */
export function mapStatus(
  value: string | number | undefined,
): AssetStatus | undefined {
  const raw = blankToNull(value);
  // An ABSENT status is quarantined exactly like an unrecognised one. This is
  // the branch that bites: a permissive default would file every blank-status
  // row as IN_STOCK, which looks like a successful import.
  if (raw === null) return undefined;
  return STATUS_MAP[raw.replace(/\s+/g, " ").toLowerCase()];
}

/**
 * Map one row. `cells` is keyed by header name (C14).
 *
 * Order of checks is deliberate: the cheapest and most disqualifying first, so
 * a row missing its tag is reported as NO_TAG rather than as whatever else also
 * happens to be wrong with it.
 */
export function mapRow(
  sourceRow: number,
  cells: Record<string, string | number>,
): MapResult {
  const fail = (problem: ImportProblem, detail?: string): MapResult => ({
    ok: false,
    problem: { sourceRow, problem, detail },
  });

  // THE IDEMPOTENCY KEY. A blank tag has none, so re-running would duplicate
  // the row — and `''` occupies the unique index, so the SECOND blank-tagged
  // row also fails with a phantom "an asset with that tag already exists"
  // (the trap recorded in am02_asset_lifecycle and
  // asset-admin.integration.test.ts:458).
  const tag = blankToNull(cells["Asset Tag ID"]);
  if (tag === null) return fail(IMPORT_PROBLEMS.NO_TAG);

  const status = mapStatus(cells["Status"]);
  if (status === undefined) {
    return fail(
      IMPORT_PROBLEMS.UNKNOWN_STATUS,
      blankToNull(cells["Status"]) ?? "(blank)",
    );
  }

  const categoryName = blankToNull(cells["Category"]);
  if (categoryName === null) return fail(IMPORT_PROBLEMS.NO_CATEGORY);

  const purchasePrice = parseMoney(cells["Cost"]);
  if (purchasePrice === undefined) {
    return fail(IMPORT_PROBLEMS.BAD_PRICE, String(cells["Cost"]).trim());
  }

  // A date cell must be NUMERIC. A string here is quarantined, never parsed —
  // see excelSerialToDate.
  const rawDate = cells["Purchase Date"];
  let purchasedAt: Date | null = null;
  if (blankToNull(rawDate) !== null) {
    if (typeof rawDate !== "number") {
      return fail(IMPORT_PROBLEMS.BAD_DATE, String(rawDate).trim());
    }
    purchasedAt = excelSerialToDate(rawDate);
    if (purchasedAt === null) {
      return fail(IMPORT_PROBLEMS.BAD_DATE, String(rawDate));
    }
  }

  const assigneeName = blankToNull(cells["Assigned to"]);

  // AN ASSIGNED ASSET WITH NO HOLDER is the invariant the register exists to
  // prevent — `Asset.status = ASSIGNED` with no open `Assignment` is a state
  // the database cannot forbid (a CHECK cannot cross tables), so it is refused
  // here at the only point it can be.
  if (status === AssetStatus.ASSIGNED && assigneeName === null) {
    return fail(IMPORT_PROBLEMS.ASSIGNED_WITHOUT_HOLDER);
  }

  return {
    ok: true,
    row: {
      sourceRow,
      tag,
      description: blankToNull(cells["Description"]),
      make: blankToNull(cells["Brand"]),
      model: blankToNull(cells["Model"]),
      serial: blankToNull(cells["Serial No"]),
      supplier: blankToNull(cells["Purchased from"]),
      purchasedAt,
      purchasePrice,
      poNumber: blankToNull(cells["P.O Number"]),
      costCentre: blankToNull(cells["CC"]),
      department: blankToNull(cells["Department"]),
      // Free text WITHIN a site. The export's `Location` column is what feeds
      // `Site.name` below — this is the finer-grained place under it.
      location: blankToNull(cells["Location"]),
      categoryName,
      // SITE COMES FROM `Location`, NOT `City/Station` (advisor condition C17).
      // The obvious reading — City/Station is the site — would name the
      // client's PERMANENT site rows "KE02" and discard "IITA Nairobi ICIPE
      // Office", the only human-readable place in the row. Sites are renamed,
      // never removed, and a rename cannot merge, so the wrong choice here is
      // expensive. The export's own `Site` column wins when populated; it is
      // blank in every row we have seen.
      siteName: blankToNull(cells["Site"]) ?? blankToNull(cells["Location"]),
      assigneeName,
      status,
    },
  };
}

/**
 * Validate the header row against `EXPECTED_HEADERS`.
 *
 * A mismatch fails the WHOLE FILE rather than every row individually: a header
 * that does not match means we are reading a different export shape, and 400
 * identical per-row errors is a worse report than one accurate file-level one.
 * Returns the missing headers, empty when the file is good.
 *
 * Extra columns are TOLERATED — the legacy register's export options add columns, and
 * rejecting a file for carrying more than we read would be a cutover blocker
 * for no safety gain. Missing ones are not.
 */
export function missingHeaders(headers: readonly string[]): string[] {
  const present = new Set(headers.map((header) => header.trim()));
  return EXPECTED_HEADERS.filter((expected) => !present.has(expected));
}
