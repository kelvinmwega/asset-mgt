// Synthetic .xlsx workbooks for the AM-04 parser tests (advisor condition
// AM-04-C39).
//
// EVERY VALUE HERE IS INVENTED. The client's real legacy export carries
// three staff names, a serial, a PO number and a cost centre, and `.gitignore`
// blocks `*.xlsx`/`*.xls`/`*.csv` repo-wide so it can never be committed as a
// fixture. Building the workbook in code instead is not a workaround for that
// rule — it is the better artefact, because a fixture nobody can read cannot
// show a reviewer which awkward shape a test is about.
//
// The shapes ARE the point. A tidy workbook proves nothing about a file whose
// sparse cells, text-in-a-money-column and two different date encodings are the
// whole reason this reader is hand-written. `legacyExportWorkbook()` reproduces
// them, cell type by cell type, from the design's §1.1 table.

import { zipSync, strToU8 } from "fflate";

/**
 * One `<c>` element.
 *
 * With neither `text` nor `num` nor `xml` the cell is written
 * styled-but-valueless (`<c r="D197" s="2"/>`), which is exactly what the real
 * export's ~187 trailing rows contain. To leave a cell out ENTIRELY — the
 * sparse case, where there is no `<c>` at all — omit it from the row instead.
 */
export type CellSpec = {
  col: string;
  /** Shared-string value: interned and written as `t="s"`. */
  text?: string;
  /** Bare numeric value: written with no `t` attribute. */
  num?: number;
  /** Style index, e.g. `"2"` for a date format or `"3"` for currency. */
  style?: string;
  /** A literal `<c …>` element, for shapes the helpers refuse to build. */
  xml?: string;
};

export type RowSpec = { row: number; cells: CellSpec[] };

export type WorkbookSpec = {
  /** Defaults to a single `<sheet name="Export" r:id="rId1"/>`. */
  sheets?: { name: string; rid: string }[];
  /** The `date1904` attribute value to emit on `<workbookPr>`. */
  date1904?: boolean | string;
  /** The rels Target for rId1, relative to `xl/`. */
  sheetTarget?: string;
  /** The archive entry the worksheet is actually stored under. */
  sheetEntry?: string;
  /** The rels Type for rId1, for the wrong-part-type case. */
  sheetRelType?: string;
  rows?: RowSpec[];
  /** Replaces the generated `<sheetData>` body wholesale. */
  sheetDataXml?: string;
  /** Replaces the generated `xl/workbook.xml` wholesale. */
  workbookXml?: string;
  /** Replaces the generated `xl/_rels/workbook.xml.rels` wholesale. */
  relsXml?: string;
  /** Extra archive entries — a bomb, or a second worksheet. */
  extraEntries?: Record<string, Uint8Array>;
};

const WORKSHEET_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the archive.
 *
 * Shared strings are interned in first-use order, which is what Excel does and
 * what makes the fixture's sharedStrings.xml look like the real one.
 */
export function buildWorkbook(spec: WorkbookSpec = {}): Uint8Array {
  const sheets = spec.sheets ?? [{ name: "Export", rid: "rId1" }];
  const sheetTarget = spec.sheetTarget ?? "worksheets/sheet1.xml";
  const sheetEntry = spec.sheetEntry ?? `xl/${sheetTarget}`;

  const shared: string[] = [];
  const intern = (value: string): number => {
    const existing = shared.indexOf(value);
    if (existing !== -1) return existing;
    return shared.push(value) - 1;
  };

  const rowsXml = (spec.rows ?? [])
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          if (cell.xml !== undefined) return cell.xml;
          const ref = `${cell.col}${row.row}`;
          const style = cell.style ? ` s="${cell.style}"` : "";
          if (cell.text !== undefined) {
            return `<c r="${ref}"${style} t="s"><v>${intern(cell.text)}</v></c>`;
          }
          if (cell.num !== undefined) {
            return `<c r="${ref}"${style}><v>${cell.num}</v></c>`;
          }
          return `<c r="${ref}"${style}/>`;
        })
        .join("");
      return `<row r="${row.row}">${cells}</row>`;
    })
    .join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${spec.sheetDataXml ?? rowsXml}</sheetData>` +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`;

  // `absPath` and docProps/core.xml are here on purpose, carrying the shape of
  // the personal data the real file holds. AM-04-C38 says the reader never
  // reads them; a fixture without them could not show that it does not.
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">` +
    `<workbookPr defaultThemeVersion="202300"${
      spec.date1904 === undefined || spec.date1904 === false
        ? ""
        : ` date1904="${spec.date1904 === true ? "1" : spec.date1904}"`
    }/>` +
    `<mc:AlternateContent><mc:Choice Requires="x15">` +
    `<x15ac:absPath url="C:\\Users\\NOBODY\\Downloads\\" ` +
    `xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/>` +
    `</mc:Choice></mc:AlternateContent>` +
    `<sheets>` +
    sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="${sheet.rid}"/>`,
      )
      .join("") +
    `</sheets></workbook>`;

  // rId1 is written LAST on purpose. Excel emits the parts in no particular
  // order, and a lookup that took the first <Relationship> instead of matching
  // on Id would read styles.xml here and still look like it worked if the
  // worksheet happened to come first.
  const relsXml =
    spec.relsXml ??
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
      `<Relationship Id="rId1" Type="${spec.sheetRelType ?? WORKSHEET_REL_TYPE}" ` +
      `Target="${escapeXml(sheetTarget)}"/>` +
      `</Relationships>`;

  const sharedXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join("") +
    `</sst>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types/>`,
      ),
      "xl/workbook.xml": strToU8(spec.workbookXml ?? workbookXml),
      "xl/_rels/workbook.xml.rels": strToU8(relsXml),
      "xl/sharedStrings.xml": strToU8(sharedXml),
      "xl/styles.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet/>`,
      ),
      [sheetEntry]: strToU8(sheetXml),
      "docProps/core.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">` +
          `<cp:lastModifiedBy>Nobody Fictional (SYNTHETIC)</cp:lastModifiedBy>` +
          `</cp:coreProperties>`,
      ),
      ...spec.extraEntries,
    },
    { level: 9 },
  );
}

/**
 * The 21 columns of the legacy export template, in the file's own order.
 *
 * The reader resolves columns by NAME, so this order is a fact about the client
 * file rather than an assumption the code makes — `shuffled()` below exists to
 * hold that distinction honest.
 */
export const LEGACY_EXPORT_HEADERS = [
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

/** The sample row's values, invented, keyed the way the reader returns them. */
export const SAMPLE_ROW: Record<string, string | number> = {
  "Asset Tag ID": "KE000001",
  Description: "Generic USB-C Docking Station",
  "Purchased from": "Example Technologies",
  // Bare numeric serial. 45177 is 2023-09-08 on the 1899-12-30 epoch.
  "Purchase Date": 45177,
  // A shared STRING in a `$0.00`-formatted cell (design F-F).
  Cost: "229.81",
  "Serial No": "SN0000000001",
  "Asset Type": "CE",
  "City/Station": "XX01",
  CC: "CC0001",
  "P.O Number": "PO000000000001",
  Location: "Example Office",
  Category: "DOCKING STATION",
  Department: "Example Department",
  "Assigned to": "Ada Placeholder",
  // A US-format date STRING, in the same file as the serial above (design F-B).
  "Date Created": "07/29/2024 07:08 AM",
  "Created by": "Sam Placeholder",
  Status: "Available",
};

/** `0` → `"A"`, `26` → `"AA"`. */
export function columnLetter(index: number): string {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * A faithful stand-in for the client's export: 21 headers, one data row with
 * Brand, Model, PID and Site carrying NO `<c>` element at all, and 187 trailing
 * rows holding a style on D and F and nothing else.
 *
 * `headerOrder` is a parameter so a test can shuffle the columns and assert the
 * same values come back under the same names.
 */
export function legacyExportWorkbook(
  options: {
    headerOrder?: readonly string[];
    row?: Record<string, string | number>;
    trailingRows?: number;
  } = {},
): Uint8Array {
  const headers = options.headerOrder ?? LEGACY_EXPORT_HEADERS;
  const values = options.row ?? SAMPLE_ROW;
  const trailingRows = options.trailingRows ?? 187;

  const headerRow: RowSpec = {
    row: 1,
    cells: headers.map((header, index) => ({
      col: columnLetter(index),
      text: header,
      style: "1",
    })),
  };

  const dataRow: RowSpec = {
    row: 2,
    // `.flatMap` with an empty array is what produces the sparse case: a column
    // whose value is absent gets no `<c>` element, not an empty one.
    cells: headers.flatMap((header, index): CellSpec[] => {
      const value = values[header];
      if (value === undefined) return [];
      const col = columnLetter(index);
      if (typeof value === "number") return [{ col, num: value, style: "2" }];
      // Cost keeps the currency style it has in the real file — text sitting in
      // a `$0.00` column is the trap, and a fixture that dropped the style
      // would stop looking like the thing it stands in for.
      return [{ col, text: value, style: header === "Cost" ? "3" : undefined }];
    }),
  };

  const trailing: RowSpec[] = Array.from(
    { length: trailingRows },
    (_unused, index) => ({
      row: index + 3,
      cells: [
        { col: "D", style: "2" },
        { col: "F", style: "3" },
      ],
    }),
  );

  return buildWorkbook({ rows: [headerRow, dataRow, ...trailing] });
}

/**
 * `size` bytes that deflate to almost nothing — the payload of a zip bomb.
 *
 * Zeros compress at roughly 1000:1, so a few megabytes here costs a few
 * kilobytes in the archive and milliseconds in the suite, while still blowing
 * any cap a test lowers to meet it. Allocating an actual gigabyte to make the
 * same point would only prove the suite can be made slow.
 */
export function compressiblePayload(size: number): Uint8Array {
  return new Uint8Array(size);
}

/**
 * Zero the uncompressed-size field in one entry's LOCAL FILE HEADER.
 *
 * Models the case the cheap pre-check cannot cover: an archive that lies about
 * how big an entry will be. `zipSync` writes truthful sizes, so without this
 * every fixture would be refused on its own declaration and the running byte
 * count — the guard that actually matters — would never be reached by a test.
 *
 * Only the declared size is touched; the compressed size stays correct, so the
 * entry still inflates normally and the bomb is still a bomb.
 */
export function understateEntrySize(
  zip: Uint8Array,
  entryName: string,
): Uint8Array {
  const patched = zip.slice();
  const name = strToU8(entryName);
  const view = new DataView(patched.buffer);
  const LOCAL_HEADER_SIGNATURE = 0x04034b50;
  const NAME_LENGTH_OFFSET = 26;
  const UNCOMPRESSED_SIZE_OFFSET = 22;
  const HEADER_BYTES = 30;

  for (let at = 0; at + HEADER_BYTES <= patched.length; at += 1) {
    if (view.getUint32(at, true) !== LOCAL_HEADER_SIGNATURE) continue;
    if (view.getUint16(at + NAME_LENGTH_OFFSET, true) !== name.length) continue;
    const candidate = patched.subarray(
      at + HEADER_BYTES,
      at + HEADER_BYTES + name.length,
    );
    if (!name.every((byte, index) => candidate[index] === byte)) continue;
    view.setUint32(at + UNCOMPRESSED_SIZE_OFFSET, 0, true);
    return patched;
  }
  throw new Error(`No local file header for "${entryName}" in this archive.`);
}
