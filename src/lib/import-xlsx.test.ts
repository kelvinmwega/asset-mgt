// The AM-04 XLSX reader as a contract, and its guards as red-provable claims.
// Pure module, no DB.
//
// Every workbook here is built in code (advisor condition AM-04-C39). The
// client's real export is gitignored and carries three staff names; a fixture
// that reproduces its awkward SHAPES — sparse cells, text in a money column,
// two date encodings in one file — proves what the real file would prove and
// can be read by a reviewer.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  LEGACY_EXPORT_HEADERS,
  legacyExportWorkbook,
  buildWorkbook,
  columnLetter,
  compressiblePayload,
  SAMPLE_ROW,
  understateEntrySize,
} from "../../test/xlsx-fixture";
import { parseAssetWorkbook, XLSX_LIMITS } from "@/lib/import-xlsx";

/** Caps wide enough that only the one a test lowers can be the one that fires. */
const WIDE = {
  maxInputBytes: 64 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 1_000_000,
  maxEntries: 4096,
};

const BOMB_BYTES = 4 * 1024 * 1024;
/**
 * Larger than one shipped push can produce (~16.5 MB at 16 KiB in, given
 * deflate's ~1032:1 ceiling), so a partial abort is observable against the
 * PRODUCTION default rather than only against a lowered one. Compresses to a
 * few tens of KB, so the fixture itself stays small.
 */
const BIG_BOMB_BYTES = 48 * 1024 * 1024;

/** A workbook whose worksheet entry IS the bomb — the name is the allowlist's. */
function bombAtWorksheet(size: number = BOMB_BYTES): Uint8Array {
  return buildWorkbook({
    extraEntries: {
      "xl/worksheets/sheet1.xml": compressiblePayload(size),
    },
    rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
  });
}

function messageFrom(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the parse to throw, and it did not");
}

// ---------------------------------------------------------------------------

describe("parseAssetWorkbook — the export's real shape (AM-04-C39)", () => {
  it("reads the 21 headers and the single data row, dropping the 187 formatting-only rows", () => {
    const sheet = parseAssetWorkbook(legacyExportWorkbook());

    expect(sheet.headers).toEqual([...LEGACY_EXPORT_HEADERS]);
    // Exact count, not a floor: the template's trailing rows carry a currency
    // style on D and F and no value anywhere, and emitting them would hand the
    // batch runner 187 spurious quarantines.
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0].rowNumber).toBe(2);
    expect(sheet.rows[0].cells).toEqual(SAMPLE_ROW);
  });

  it("returns raw cell values — the serial as a number, the cost as text", () => {
    const [row] = parseAssetWorkbook(legacyExportWorkbook()).rows;

    // 45177 is 2023-09-08. Turning it into a Date is the mapper's job, and the
    // reader handing it over as a number is what keeps that decision in one
    // place instead of half-made here.
    expect(row.cells["Purchase Date"]).toBe(45177);
    expect(typeof row.cells["Purchase Date"]).toBe("number");
    // Design F-F: a shared STRING sitting in a `$0.00`-formatted cell. The
    // strict decimal rule (AM-04-C13) needs to see the text exactly as typed.
    expect(row.cells.Cost).toBe("229.81");
    expect(typeof row.cells.Cost).toBe("string");
    // The other half of F-B: a US-format date string in the same file.
    expect(row.cells["Date Created"]).toBe("07/29/2024 07:08 AM");
  });

  it("omits the four columns with no <c> element rather than inventing empties", () => {
    const [row] = parseAssetWorkbook(legacyExportWorkbook()).rows;

    for (const absent of ["Brand", "Model", "PID", "Site"]) {
      expect(row.cells).not.toHaveProperty(absent);
    }
    // Paired positive: the columns either side of each gap did arrive, so the
    // assertions above are about absent cells and not about an empty parse.
    expect(row.cells["Purchase Date"]).toBe(45177);
    expect(row.cells["Serial No"]).toBe("SN0000000001");
  });
});

describe("columns are resolved by header NAME (AM-04-C14)", () => {
  it("keys sparse cells by name, not by their position among the row's <c> elements", () => {
    const [row] = parseAssetWorkbook(legacyExportWorkbook()).rows;

    // THE misalignment this guard exists for. Serial No is column H, but it is
    // only the SIXTH `<c>` element in the row, because Brand (E) and Model (G)
    // have none. A reader that zipped cells against headers positionally would
    // file "SN0000000001" under "Cost" — which is the sixth HEADER.
    expect(row.cells["Serial No"]).toBe("SN0000000001");
    expect(row.cells.Cost).toBe("229.81");
    expect(row.cells["Asset Type"]).toBe("CE");
  });

  it("does not assume the column order the client's file happens to use", () => {
    const shuffled = [...LEGACY_EXPORT_HEADERS].reverse();
    const sheet = parseAssetWorkbook(
      legacyExportWorkbook({ headerOrder: shuffled }),
    );

    expect(sheet.headers).toEqual(shuffled);
    expect(sheet.rows[0].cells).toEqual(SAMPLE_ROW);
  });

  it("refuses a value sitting in a column the header row does not name", () => {
    const workbook = buildWorkbook({
      rows: [
        { row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] },
        {
          row: 2,
          cells: [
            { col: "A", text: "KE000001" },
            { col: "C", text: "orphaned" },
          ],
        },
      ],
    });

    expect(() => parseAssetWorkbook(workbook)).toThrow(
      /cell C2 carries a value in a column the header row does not name/,
    );
  });

  it('refuses a cell with no r="" reference rather than guessing its column', () => {
    const workbook = buildWorkbook({
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
      sheetDataXml:
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
        `<row r="2"><c t="s"><v>0</v></c></row>`,
    });

    expect(() => parseAssetWorkbook(workbook)).toThrow(
      /no usable r="" reference/,
    );
  });

  it("refuses a header row that names the same column twice", () => {
    const workbook = buildWorkbook({
      rows: [
        {
          row: 1,
          cells: [
            { col: "A", text: "Cost" },
            { col: "B", text: "Cost" },
          ],
        },
      ],
    });

    expect(() => parseAssetWorkbook(workbook)).toThrow(/names "Cost" twice/);
  });
});

describe("cell types fail closed (AM-04-C37)", () => {
  const workbookWithCell = (cellXml: string) =>
    buildWorkbook({
      rows: [
        {
          row: 1,
          cells: [
            { col: "A", text: "Asset Tag ID" },
            { col: "B", text: "Serial No" },
          ],
        },
        {
          row: 2,
          cells: [
            { col: "A", text: "KE000001" },
            { col: "B", xml: cellXml },
          ],
        },
      ],
    });

  it.each([
    ["inlineStr", `<c r="B2" t="inlineStr"><is><t>SN0000000001</t></is></c>`],
    ["str", `<c r="B2" t="str"><v>SN0000000001</v></c>`],
    ["b", `<c r="B2" t="b"><v>1</v></c>`],
    ["e", `<c r="B2" t="e"><v>#N/A</v></c>`],
    // Legal OOXML and identical in meaning to a bare numeric — refused anyway,
    // because widening the allowlist is a ruling, not a guess.
    ["n", `<c r="B2" t="n"><v>1234</v></c>`],
  ])('refuses t="%s" instead of reading it as empty', (type, cellXml) => {
    expect(() => parseAssetWorkbook(workbookWithCell(cellXml))).toThrow(
      new RegExp(`has cell type "${type}"`),
    );
  });

  it("reads the two types it does handle, so the refusals above are not a dead parse", () => {
    const sheet = parseAssetWorkbook(
      workbookWithCell(`<c r="B2" t="s"><v>1</v></c>`),
    );
    // Shared string index 1 is "Serial No" — the second string interned by the
    // fixture. The point is that the value arrived at all.
    expect(sheet.rows[0].cells["Serial No"]).toBe("Serial No");
  });

  it("refuses a bare numeric cell whose value is not a number", () => {
    expect(() =>
      parseAssetWorkbook(workbookWithCell(`<c r="B2"><v>1,229.81</v></c>`)),
    ).toThrow(/holds "1,229.81", which is not a number/);
  });

  it.each([
    ["a negative", "-1.5", -1.5],
    ["an integer", "45177", 45177],
    ["an exponent", "1.25e-3", 0.00125],
    ["a capital exponent", "2E3", 2000],
    ["a multi-digit exponent", "1e10", 1e10],
  ])("reads %s written as a bare numeric", (_label, raw, expected) => {
    const sheet = parseAssetWorkbook(
      workbookWithCell(`<c r="B2"><v>${raw}</v></c>`),
    );
    expect(sheet.rows[0].cells["Serial No"]).toBe(expected);
  });

  it.each([
    ["two decimal points", "1.2.3"],
    ["a bare exponent marker", "1e"],
    ["no leading digit", ".5"],
    ["a trailing sign", "1e+"],
    ["letters", "twelve"],
  ])("refuses %s in a bare numeric cell", (_label, raw) => {
    // Number("") is 0 and Number("1e") is NaN — both would reach the register
    // as a value nobody typed. The pattern is what stops that, so its edges are
    // pinned rather than assumed.
    expect(() =>
      parseAssetWorkbook(workbookWithCell(`<c r="B2"><v>${raw}</v></c>`)),
    ).toThrow(/is not a number/);
  });

  it.each([
    [
      "an unhandled type",
      `<c t="inlineStr"><is><t>x</t></is></c>`,
      /has cell type/,
    ],
    [
      "a non-numeric shared index",
      `<c t="s"><v>abc</v></c>`,
      /is a shared string/,
    ],
    [
      "an out-of-range shared index",
      `<c t="s"><v>9999</v></c>`,
      /references shared string/,
    ],
    ["a non-numeric bare value", `<c><v>twelve</v></c>`, /is not a number/],
  ])(
    'names the row when a cell with %s carries no r="" of its own',
    (_label, cellXml, expected) => {
      // Every one of these throws quotes the cell reference, and every one has
      // to survive that reference being absent — otherwise the operator gets
      // "Import file cell undefined ..." and no way to find the row.
      const message = messageFrom(() =>
        parseAssetWorkbook(workbookWithCell(cellXml)),
      );
      expect(message).toMatch(expected);
      expect(message).toContain("on row 2");
    },
  );

  it("refuses a shared-string index the table does not hold", () => {
    expect(() =>
      parseAssetWorkbook(workbookWithCell(`<c r="B2" t="s"><v>9999</v></c>`)),
    ).toThrow(/references shared string 9999/);
  });

  it.each([
    ["not a number at all", "abc"],
    ["negative", "-1"],
    ["fractional", "1.5"],
  ])("refuses a shared-string index that is %s", (_label, raw) => {
    expect(() =>
      parseAssetWorkbook(workbookWithCell(`<c r="B2" t="s"><v>${raw}</v></c>`)),
    ).toThrow(new RegExp(`shared string whose index is "${raw}"`));
  });
});

describe("the 1904 date system is refused outright (AM-04-C36)", () => {
  it("rejects the whole file rather than importing every date 1462 days out", () => {
    expect(() => parseAssetWorkbook(legacyMacExport())).toThrow(
      /1904 date system/,
    );
  });

  it('rejects the spelling date1904="true" as well as date1904="1"', () => {
    // Both spellings are legal for an XML boolean, and a producer that writes
    // the word rather than the digit must not slip past.
    expect(() => parseAssetWorkbook(legacyMacExport("true"))).toThrow(
      /1904 date system/,
    );
  });

  it.each([["0"], ["false"]])('accepts an explicit date1904="%s"', (flag) => {
    expect(parseAssetWorkbook(legacyMacExport(flag)).rows).toHaveLength(1);
  });

  it("accepts the same workbook with no flag at all", () => {
    expect(parseAssetWorkbook(legacyExportWorkbook()).rows).toHaveLength(1);
  });

  function legacyMacExport(flag: boolean | string = true): Uint8Array {
    return buildWorkbook({
      date1904: flag,
      rows: [
        { row: 1, cells: [{ col: "A", text: "Purchase Date" }] },
        { row: 2, cells: [{ col: "A", num: 45177, style: "2" }] },
      ],
    });
  }
});

describe("the worksheet is resolved through the rels (AM-04-C35)", () => {
  it("reads the entry the rels name, not a hardcoded xl/worksheets/sheet1.xml", () => {
    // There is deliberately NO xl/worksheets/sheet1.xml in this archive. A
    // reader that hardcoded that path finds nothing and throws.
    const workbook = buildWorkbook({
      sheetTarget: "worksheets/renamedByExcel.xml",
      rows: [
        { row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] },
        { row: 2, cells: [{ col: "A", text: "KE000001" }] },
      ],
    });

    expect(parseAssetWorkbook(workbook).rows[0].cells["Asset Tag ID"]).toBe(
      "KE000001",
    );
  });

  it("refuses a workbook holding more than one sheet", () => {
    const workbook = buildWorkbook({
      sheets: [
        { name: "Export", rid: "rId1" },
        { name: "Notes", rid: "rId4" },
      ],
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
    });

    expect(() => parseAssetWorkbook(workbook)).toThrow(/holds 2 sheets/);
  });

  it("refuses a sheet relationship pointing at a part that is not a worksheet", () => {
    const workbook = buildWorkbook({
      sheetRelType:
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
    });

    expect(() => parseAssetWorkbook(workbook)).toThrow(/not a worksheet/);
  });

  it("cannot be walked out of the archive by a traversing Target", () => {
    const workbook = buildWorkbook({
      sheetTarget: "../../../../etc/passwd",
      sheetEntry: "xl/worksheets/sheet1.xml",
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
    });

    // The name is matched against the archive's entries as a string and matches
    // nothing. Nothing was resolved as a filesystem path, so there is no
    // sanitiser here to get wrong.
    expect(() => parseAssetWorkbook(workbook)).toThrow(
      /missing "xl\/\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd"/,
    );
  });
});

describe("zip caps (AM-04-C34)", () => {
  it("pins the ruled cap values", () => {
    // Written out as literals rather than derived, so a test cannot agree with
    // a mistake in the constants it is checking.
    expect(XLSX_LIMITS).toEqual({
      maxInputBytes: 10 * 1024 * 1024,
      maxTotalBytes: 64 * 1024 * 1024,
      maxEntryBytes: 64 * 1024 * 1024,
      maxCompressionRatio: 100,
      maxEntries: 64,
      pushChunkBytes: 16 * 1024,
    });
  });

  it("refuses an oversized input before inflating anything", () => {
    const workbook = legacyExportWorkbook({ trailingRows: 0 });

    expect(() =>
      parseAssetWorkbook(workbook, { maxInputBytes: workbook.length - 1 }),
    ).toThrow(/bytes, past the .* limit/);
    expect(
      parseAssetWorkbook(workbook, { maxInputBytes: workbook.length }).rows,
    ).toHaveLength(1);
  });

  it("refuses an archive with too many entries", () => {
    const extraEntries = Object.fromEntries(
      Array.from({ length: 60 }, (_unused, index) => [
        `xl/media/image${index}.png`,
        strToU8("."),
      ]),
    );
    const workbook = buildWorkbook({
      extraEntries,
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
    });

    expect(() => parseAssetWorkbook(workbook, { maxEntries: 64 })).toThrow(
      /holds more than 64 entries/,
    );
    // Paired positive: the same archive reads fine when the cap admits it, so
    // the refusal above is about the count and not about the archive.
    expect(parseAssetWorkbook(workbook, { maxEntries: 128 }).headers).toEqual([
      "Asset Tag ID",
    ]);
  });

  it("admits exactly the cap and refuses one more", () => {
    // The boundary, pinned. "More than 64" and "64 or more" are a one-character
    // difference that no test comparing 67 against 64 can tell apart, and the
    // real file's 10 entries would never notice either.
    const entries = 67;
    const workbook = buildWorkbook({
      extraEntries: Object.fromEntries(
        Array.from({ length: entries - 7 }, (_unused, index) => [
          `xl/media/image${index}.png`,
          strToU8("."),
        ]),
      ),
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
    });

    expect(
      parseAssetWorkbook(workbook, { maxEntries: entries }).headers,
    ).toEqual(["Asset Tag ID"]);
    expect(() =>
      parseAssetWorkbook(workbook, { maxEntries: entries - 1 }),
    ).toThrow(new RegExp(`holds more than ${entries - 1} entries`));
  });

  // -------------------------------------------------------------------------
  // The two-variant bomb. Both entries hold the same payload; only the NAME
  // differs, and that difference is the whole test. A reader that inflated
  // everything and discarded what it did not want would pass the first and die
  // on the second.
  // -------------------------------------------------------------------------

  it("variant 1 — never inflates a bomb outside the four-entry allowlist", () => {
    const workbook = buildWorkbook({
      extraEntries: { "xl/media/bomb.bin": compressiblePayload(BOMB_BYTES) },
      rows: [
        { row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] },
        { row: 2, cells: [{ col: "A", text: "KE000001" }] },
      ],
    });

    // The caps are the REAL ones here. 4 MB is well inside them individually,
    // but the file is ~4 KB packed, so inflating the bomb would blow the 100:1
    // ratio instantly. Success is the assertion: the entry was never started.
    expect(parseAssetWorkbook(workbook).rows[0].cells["Asset Tag ID"]).toBe(
      "KE000001",
    );
  });

  // AM-04-C34, the mutation that actually matters. The variant-2 test below
  // overrides `pushChunkBytes` so the abort lands early without a
  // gigabyte-sized fixture — which means it does NOT exercise the PRODUCTION
  // default, and setting XLSX_LIMITS.pushChunkBytes to the whole buffer (the
  // natural "why push in chunks?" optimisation) left every behavioural test
  // green. Only the value-pinning test noticed, and a pinned constant is not a
  // guard, it is a description.
  //
  // This test uses the SHIPPED default. Both halves are load-bearing and the
  // distinction is easy to lose: the push size bounds ONE inflate call's
  // allocation (~16.5 MB at 16 KiB, given deflate's ~1032:1 max expansion), and
  // the cumulative byte count is what bounds the TOTAL — 640 pushes of a 10 MB
  // file still reach ~10 GB without it. Deleting either one must fail here.
  it("aborts a worksheet-named bomb at the SHIPPED push size", () => {
    // THE FIXTURE HAS TO BE BIGGER THAN ONE PUSH'S WORST CASE, and the 4 MB
    // bomb above is not. At the shipped 16 KiB push, deflate's ~1032:1 maximum
    // expansion allows ~16.5 MB from a single inflate call — so a 4 MB entry
    // is materialised whole inside one push and the abort CANNOT be partial.
    // The first version of this test asserted otherwise and failed with
    // `expected 4194304 to be less than 4194304`, which is the shipped code
    // behaving exactly as specified, not a defect.
    const workbook = understateEntrySize(
      bombAtWorksheet(BIG_BOMB_BYTES),
      "xl/worksheets/sheet1.xml",
    );

    const message = messageFrom(() =>
      parseAssetWorkbook(workbook, {
        ...WIDE,
        maxEntryBytes: 512 * 1024,
        // Deliberately NO pushChunkBytes override — that is the whole point.
      }),
    );

    expect(message).toMatch(/per-entry limit/);
    const aborted = Number(/aborted after (\d+) bytes/.exec(message)?.[1]);
    // With the shipped push size this stops after roughly one push's worth.
    // Set pushChunkBytes to the whole buffer and the entry inflates in full
    // before the abort fires, making this figure BIG_BOMB_BYTES exactly.
    expect(aborted).toBeLessThan(BIG_BOMB_BYTES);
  });

  it("variant 2 — aborts PART WAY THROUGH a bomb named as the worksheet", () => {
    // The local header's declared size is zeroed first, so the free pre-check
    // cannot fire and the running byte count is the only thing left standing —
    // which is the point. A liar's header is the case the pre-check is not a
    // defence against.
    const workbook = understateEntrySize(
      bombAtWorksheet(),
      "xl/worksheets/sheet1.xml",
    );

    const message = messageFrom(() =>
      parseAssetWorkbook(workbook, {
        ...WIDE,
        maxEntryBytes: 512 * 1024,
        // A small push chunk bounds how much one inflate call can allocate; see
        // XlsxLimits.pushChunkBytes. Lowered here so the abort lands early
        // enough to be visibly partial without a gigabyte-sized fixture.
        pushChunkBytes: 256,
      }),
    );

    expect(message).toMatch(/per-entry limit/);
    // THE assertion that separates a streaming abort from a post-mortem. If
    // this module inflated the entry and then measured it, the reported figure
    // would be the bomb's full size. It must be a fraction of it.
    const aborted = Number(/aborted after (\d+) bytes/.exec(message)?.[1]);
    expect(aborted).toBeGreaterThan(512 * 1024);
    expect(aborted).toBeLessThan(BOMB_BYTES / 2);
  });

  it("refuses an entry whose own header declares more than the per-entry cap", () => {
    const message = messageFrom(() =>
      parseAssetWorkbook(bombAtWorksheet(), {
        ...WIDE,
        maxEntryBytes: 512 * 1024,
      }),
    );

    // Refused on the declaration, so not one byte was inflated. Free when the
    // file is honest; worth nothing when it is not, which is why the running
    // count above exists as well.
    expect(message).toMatch(/declares 4194304 bytes/);
  });

  it("refuses a run whose entries are individually small but jointly too large", () => {
    const workbook = buildWorkbook({
      extraEntries: {
        "xl/sharedStrings.xml": compressiblePayload(3 * 1024 * 1024),
        "xl/worksheets/sheet1.xml": compressiblePayload(3 * 1024 * 1024),
      },
      rows: [{ row: 1, cells: [{ col: "A", text: "Asset Tag ID" }] }],
    });

    expect(() =>
      parseAssetWorkbook(workbook, {
        ...WIDE,
        maxEntryBytes: 4 * 1024 * 1024,
        maxTotalBytes: 5 * 1024 * 1024,
      }),
    ).toThrow(/total limit/);
  });

  it("refuses a file that expands further than the ratio cap allows", () => {
    expect(() =>
      parseAssetWorkbook(bombAtWorksheet(), {
        ...WIDE,
        maxCompressionRatio: 100,
      }),
    ).toThrow(/expands more than 100× its packed size/);
  });
});

describe("package metadata is never read or surfaced (AM-04-C38)", () => {
  it("returns nothing from docProps or the workbook's absPath", () => {
    const sheet = parseAssetWorkbook(legacyExportWorkbook());
    const serialised = JSON.stringify(sheet);

    // The fixture carries both, in the shapes the real export carries them:
    // a `<cp:lastModifiedBy>` full name and a Windows user directory.
    expect(serialised).not.toContain("Nobody Fictional");
    expect(serialised).not.toContain("NOBODY");
    expect(serialised).not.toContain("absPath");
    // The positive marker, without which the three assertions above would pass
    // just as happily against a parse that returned nothing at all.
    expect(serialised).toContain("KE000001");
  });
});

describe("XML entities are expanded from a fixed table, never a document's own", () => {
  const workbookWithSharedStrings = (sst: string) =>
    buildWorkbook({
      extraEntries: { "xl/sharedStrings.xml": strToU8(sst) },
      sheetDataXml:
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>1</v></c></row>`,
    });

  it("expands all five predefined references and both numeric forms", () => {
    const sheet = parseAssetWorkbook(
      workbookWithSharedStrings(
        `<sst><si><t>Purchased from</t></si>` +
          `<si><t>&amp;&lt;&gt;&quot;&apos;&#65;&#x42;</t></si></sst>`,
      ),
    );

    expect(sheet.rows[0].cells["Purchased from"]).toBe(`&<>"'AB`);
  });

  it("expands the highest legal code point", () => {
    // The upper bound, pinned at the boundary rather than well inside it.
    const sheet = parseAssetWorkbook(
      workbookWithSharedStrings(
        `<sst><si><t>Purchased from</t></si><si><t>&#x10FFFF;</t></si></sst>`,
      ),
    );

    expect(sheet.rows[0].cells["Purchased from"]).toBe(
      String.fromCodePoint(0x10ffff),
    );
  });

  it.each([
    ["leading junk", "&a#65;"],
    ["trailing junk", "&#65a;"],
  ])(
    "refuses a numeric reference with %s rather than decoding around it",
    (_label, entity) => {
      // An unanchored match would find `#65` inside either of these and hand back
      // "A", quietly rewriting a supplier name. Refusing is the only safe read.
      expect(() =>
        parseAssetWorkbook(
          workbookWithSharedStrings(
            `<sst><si><t>Purchased from</t></si><si><t>${entity}</t></si></sst>`,
          ),
        ),
      ).toThrow(/unsupported XML entity/);
    },
  );

  it("refuses a numeric reference outside the Unicode range", () => {
    expect(() =>
      parseAssetWorkbook(
        workbookWithSharedStrings(
          `<sst><si><t>Purchased from</t></si><si><t>&#xFFFFFF;</t></si></sst>`,
        ),
      ),
    ).toThrow(/unsupported XML entity "&#xFFFFFF;"/);
  });

  it("refuses a document that declares its own entity", () => {
    // A hand-rolled scanner has no entity table to recurse through, which is
    // most of why billion-laughs is not reachable here (AM-04-C40). What it
    // must not do is treat `&lol1;` as literal text, which would write a
    // corrupted supplier name into the register without a word.
    const hostile = workbookWithSharedStrings(
      `<!DOCTYPE sst [<!ENTITY lol "ha"><!ENTITY lol1 "&lol;&lol;&lol;">]>` +
        `<sst><si><t>Purchased from</t></si><si><t>&lol1;</t></si></sst>`,
    );

    expect(() => parseAssetWorkbook(hostile)).toThrow(
      /unsupported XML entity "&lol1;"/,
    );
  });
});

describe("cell and element shapes Excel really emits", () => {
  const headerThen = (cellXml: string) =>
    buildWorkbook({
      sheetDataXml:
        `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
        `<row r="2">${cellXml}</row>`,
      extraEntries: {
        "xl/sharedStrings.xml": strToU8(
          `<sst><si><t>Asset Tag ID</t></si></sst>`,
        ),
      },
    });

  it.each([
    ["a self-closing <c/>", `<c r="A2" s="2"/>`],
    ["a <c> holding a self-closing <v/>", `<c r="A2" s="2"><v/></c>`],
    ["a <c> holding an empty <v></v>", `<c r="A2" s="2"><v></v></c>`],
  ])("treats %s as no value rather than as data", (_label, cellXml) => {
    // All three are the styled-but-valueless shape the template's trailing rows
    // are made of. A reader that let any of them through would hand the mapper
    // an empty tag, which AM-02's recorded trap turns into a phantom duplicate.
    expect(parseAssetWorkbook(headerThen(cellXml)).rows).toHaveLength(0);
  });

  it("reads a shared string split across formatting runs", () => {
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        sheetDataXml:
          `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>1</v></c></row>`,
        extraEntries: {
          "xl/sharedStrings.xml": strToU8(
            `<sst><si><t>Description</t></si>` +
              `<si><r><t>Generic </t></r><r><t>Dock</t></r></si></sst>`,
          ),
        },
      }),
    );

    expect(sheet.rows[0].cells.Description).toBe("Generic Dock");
  });

  it("reads an empty shared string written as <si/>", () => {
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        sheetDataXml:
          `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>1</v></c></row>`,
        extraEntries: {
          "xl/sharedStrings.xml": strToU8(
            `<sst><si><t>Asset Tag ID</t></si><si/></sst>`,
          ),
        },
      }),
    );

    expect(sheet.rows).toHaveLength(0);
  });

  it("reads an empty shared string written as <t/>", () => {
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        sheetDataXml:
          `<row r="1"><c r="A1" t="s"><v>0</v></c>` +
          `<c r="B1" t="s"><v>1</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>2</v></c>` +
          `<c r="B2" t="s"><v>3</v></c></row>`,
        extraEntries: {
          "xl/sharedStrings.xml": strToU8(
            `<sst><si><t>Asset Tag ID</t></si><si><t>Brand</t></si>` +
              `<si><t>KE000001</t></si><si><t/></si></sst>`,
          ),
        },
      }),
    );

    // An empty shared string is a cell with no value, not the string "".
    expect(sheet.rows[0].cells).toEqual({ "Asset Tag ID": "KE000001" });
  });

  it("skips blank rows above the header row", () => {
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        rows: [
          { row: 1, cells: [{ col: "A", style: "1" }] },
          { row: 2, cells: [{ col: "A", text: "Asset Tag ID" }] },
          { row: 3, cells: [{ col: "A", text: "KE000001" }] },
        ],
      }),
    );

    expect(sheet.headers).toEqual(["Asset Tag ID"]);
    expect(sheet.rows[0].rowNumber).toBe(3);
  });

  it("trims a heading and ignores a blank one", () => {
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        rows: [
          {
            row: 1,
            cells: [
              // Excel headings pick up trailing spaces constantly, and the
              // mapper looks them up by exact name.
              { col: "A", text: "  Asset Tag ID  " },
              { col: "B", text: "   " },
            ],
          },
          { row: 2, cells: [{ col: "A", text: "KE000001" }] },
        ],
      }),
    );

    expect(sheet.headers).toEqual(["Asset Tag ID"]);
    expect(sheet.rows[0].cells["Asset Tag ID"]).toBe("KE000001");
  });

  it("resolves columns past Z", () => {
    // The 21-column export stops at U, so the base-26 arithmetic is otherwise
    // never exercised past a single letter.
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        sheetDataXml:
          `<row r="1"><c r="Z1" t="s"><v>0</v></c>` +
          `<c r="AA1" t="s"><v>1</v></c><c r="AB1" t="s"><v>2</v></c></row>` +
          `<row r="2"><c r="Z2" t="s"><v>3</v></c>` +
          `<c r="AB2" t="s"><v>4</v></c></row>`,
        extraEntries: {
          "xl/sharedStrings.xml": strToU8(
            `<sst><si><t>Zed</t></si><si><t>DoubleA</t></si>` +
              `<si><t>DoubleB</t></si><si><t>zed value</t></si>` +
              `<si><t>ab value</t></si></sst>`,
          ),
        },
      }),
    );

    expect(sheet.headers).toEqual(["Zed", "DoubleA", "DoubleB"]);
    expect(sheet.rows[0].cells).toEqual({
      Zed: "zed value",
      DoubleB: "ab value",
    });
  });

  it("orders headers by column, not by their order in the XML", () => {
    const sheet = parseAssetWorkbook(
      buildWorkbook({
        sheetDataXml:
          `<row r="1"><c r="C1" t="s"><v>0</v></c>` +
          `<c r="A1" t="s"><v>1</v></c><c r="B1" t="s"><v>2</v></c></row>`,
        extraEntries: {
          "xl/sharedStrings.xml": strToU8(
            `<sst><si><t>Third</t></si><si><t>First</t></si><si><t>Second</t></si></sst>`,
          ),
        },
      }),
    );

    expect(sheet.headers).toEqual(["First", "Second", "Third"]);
  });

  it("refuses a self-closing <row/> quietly and a numeric heading loudly", () => {
    expect(
      parseAssetWorkbook(
        buildWorkbook({
          sheetDataXml: `<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"/>`,
          extraEntries: {
            "xl/sharedStrings.xml": strToU8(
              `<sst><si><t>Asset Tag ID</t></si></sst>`,
            ),
          },
        }),
      ).rows,
    ).toHaveLength(0);

    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({ rows: [{ row: 1, cells: [{ col: "A", num: 42 }] }] }),
      ),
    ).toThrow(/non-text heading in cell A1/);
  });

  it('refuses a <row> with no usable r="" number', () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          sheetDataXml: `<row><c r="A1" t="s"><v>0</v></c></row>`,
        }),
      ),
    ).toThrow(/<row> with no usable r="" number/);
  });

  it.each([["A1X"], ["1A1"], ["a1"]])(
    "refuses the malformed cell reference %s",
    (ref) => {
      // The pattern is anchored at both ends. Unanchored, "A1X" would resolve
      // to column A and quietly file a value under the wrong heading — the
      // exact misalignment AM-04-C14 exists to prevent.
      expect(() =>
        parseAssetWorkbook(
          buildWorkbook({
            sheetDataXml: `<row r="1"><c r="${ref}" t="s"><v>0</v></c></row>`,
            extraEntries: {
              "xl/sharedStrings.xml": strToU8(
                `<sst><si><t>Asset Tag ID</t></si></sst>`,
              ),
            },
          }),
        ),
      ).toThrow(/no usable r="" reference/);
    },
  );

  it("refuses a cell reference with no row digits", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          sheetDataXml: `<row r="1"><c r="A" t="s"><v>0</v></c></row>`,
          extraEntries: {
            "xl/sharedStrings.xml": strToU8(
              `<sst><si><t>Asset Tag ID</t></si></sst>`,
            ),
          },
        }),
      ),
    ).toThrow(/no usable r="" reference \("A"\)/);
  });

  it("refuses XML it cannot scan to the end of", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          sheetDataXml: `<row r="1"><c r="A1" t="s"><v>0</v></c>`,
        }),
      ),
    ).toThrow(/unclosed <row> element/);
  });
});

describe("malformed packages are refused with a diagnosable message", () => {
  it("refuses a workbook with no <sheets>", () => {
    expect(() =>
      parseAssetWorkbook(buildWorkbook({ workbookXml: `<workbook/>` })),
    ).toThrow(/no <sheets> element/);
  });

  it("refuses a <sheet> carrying no r:id", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          workbookXml: `<workbook><sheets><sheet name="Export"/></sheets></workbook>`,
        }),
      ),
    ).toThrow(/carries no r:id/);
  });

  it("refuses a sheet relationship with no Target", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          relsXml:
            `<Relationships><Relationship Id="rId1" ` +
            `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>` +
            `</Relationships>`,
        }),
      ),
    ).toThrow(/relationship rId1 has no Target/);
  });

  it("refuses a sheet relationship with no Type", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          relsXml: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
        }),
      ),
    ).toThrow(/points at a "\(none\)" part/);
  });

  it("refuses rels that do not mention the sheet's r:id at all", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          relsXml: `<Relationships><Relationship Id="rId9" Target="worksheets/sheet1.xml"/></Relationships>`,
        }),
      ),
    ).toThrow(/do not resolve rId1 to anything/);
  });

  it("refuses a worksheet part with no <sheetData>", () => {
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          extraEntries: {
            "xl/worksheets/sheet1.xml": strToU8(`<worksheet/>`),
          },
        }),
      ),
    ).toThrow(/worksheet has no <sheetData>/);
  });

  it("refuses a part that is not valid UTF-8 rather than decoding it to mojibake", () => {
    // A wrongly-encoded export would otherwise land in the register as U+FFFD
    // runs, which no operator can correct because the original bytes are gone.
    //
    // Asserted on the DECODER's own message, not merely that something threw:
    // a lenient decoder still ends in an error here (the sheet then references
    // a shared string that decoded to nothing), so a bare `.toThrow()` passes
    // just as well with `fatal` turned off.
    expect(() =>
      parseAssetWorkbook(
        buildWorkbook({
          extraEntries: {
            "xl/sharedStrings.xml": new Uint8Array([0xff, 0xfe, 0xff, 0xfe]),
          },
        }),
      ),
    ).toThrow(/not valid for encoding/);
  });

  it("refuses an archive truncated part way through the worksheet", () => {
    // Cut in half so the worksheet entry itself is incomplete. Trimming only
    // the tail proves nothing: the four parts this reader wants all sit before
    // docProps, so a file missing its last few hundred bytes still parses.
    const workbook = legacyExportWorkbook({ trailingRows: 0 });

    expect(() =>
      parseAssetWorkbook(workbook.subarray(0, Math.floor(workbook.length / 2))),
    ).toThrow();
  });

  it("reads an archive whose length is an exact multiple of the push chunk", () => {
    // The push loop's bound is only interesting when the last chunk lands
    // exactly on the end of the archive; every other fixture overshoots.
    const workbook = legacyExportWorkbook({ trailingRows: 0 });

    expect(
      parseAssetWorkbook(workbook, { pushChunkBytes: workbook.length }).rows,
    ).toHaveLength(1);
  });
});

describe("the reader's own preconditions", () => {
  it("refuses an archive missing one of the four entries it reads", () => {
    const workbook = zipSync({ "xl/workbook.xml": strToU8("<workbook/>") });

    expect(() => parseAssetWorkbook(workbook)).toThrow(
      /missing "xl\/_rels\/workbook.xml.rels"/,
    );
  });

  it("refuses a worksheet with no header row", () => {
    expect(() => parseAssetWorkbook(buildWorkbook({ rows: [] }))).toThrow(
      /no header row/,
    );
  });

  it("numbers columns past Z the way Excel does", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(20)).toBe("U");
    expect(columnLetter(26)).toBe("AA");
  });
});
