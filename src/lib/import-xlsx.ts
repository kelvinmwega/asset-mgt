// AM-04 — the legacy-export XLSX reader.
//
// Takes the bytes of an .xlsx and returns ONE sheet's cells, keyed by header
// NAME. Nothing else: no dates, no decimals, no status vocabulary, no database.
// A shared string comes back as its text and a bare numeric comes back as a JS
// number, so the Excel serial 45177 leaves here as the NUMBER 45177 and the
// cost "229.81" leaves here as the STRING "229.81" — exactly as the file spells
// them. Coercion is src/lib/import-map.ts's job, and keeping the two apart is
// what lets the strict decimal rule (AM-04-C13) live in one place instead of
// being half-applied by whichever layer touched the value first.
//
// Pure and dependency-light on purpose: no `server-only`, no Prisma, no env. It
// is imported by a unit test and by a CLI, and neither has a request context.
//
// ---------------------------------------------------------------------------
// INVARIANT — PACKAGE METADATA IS NEVER READ (AM-04-C38)
// ---------------------------------------------------------------------------
// The four entries below are the only ones this module ever inflates. That is
// not an optimisation, it is the rule: `docProps/core.xml` in the client's real
// export carries `<cp:lastModifiedBy>` — a staff member's full name, fuller
// than anything in the cells — and `xl/workbook.xml` carries an `absPath`
// holding the exporter's Windows username. Both are personal data the register
// has no lawful reason to hold, and CLAUDE.md forbids new PII containers.
//
// `xl/workbook.xml` IS inflated, for `<sheets>` and `date1904` only. Its
// `absPath` is never extracted, never returned, never logged. A future request
// to "record who exported the file, for provenance" is refused BY THIS RULE
// rather than re-argued: there is no delete in this codebase, so a name written
// once is a name held forever.
//
// ---------------------------------------------------------------------------
// NO GENERAL XML PARSER (AM-04-C40)
// ---------------------------------------------------------------------------
// Every scan below is hand-rolled string work. That is most of why reading an
// operator-supplied file is safe at all: there is no DTD processing, no
// external entity resolution and no entity table to recurse through, so XXE and
// billion-laughs have nothing to attack. `decodeXmlText` expands exactly five
// named references plus bounded numeric ones and THROWS on any other `&name;`,
// so a document that declares its own entities is rejected rather than expanded
// or silently passed through as corrupt text. Swapping in a real XML parser
// needs a new advisor consult.
//
// ---------------------------------------------------------------------------
// PATH TRAVERSAL, STATED POSITIVELY
// ---------------------------------------------------------------------------
// Nothing here writes an entry to disk and nothing resolves an entry name as a
// filesystem path. Entries are selected by exact string equality against a set
// this module builds, and the one dynamic name (the worksheet, resolved through
// the rels) is likewise matched exactly against what the archive contains. A
// `Target="../../../etc/passwd"` therefore matches no entry and throws; it is
// not sanitised, it is structurally unreachable.

import { Unzip, UnzipInflate } from "fflate";

/** A cell's raw value: shared-string text, or a bare numeric as a number. */
export type CellValue = string | number;

/**
 * One value-bearing row. `rowNumber` is the real spreadsheet row number, so an
 * error the mapper raises three layers later is still findable in Excel.
 *
 * `cells` is keyed by HEADER NAME and holds ONLY the columns that carry a
 * value. Cells in the client's export are sparse — Brand, Model, PID and Site
 * have no `<c>` element at all on the sample row — so an absent key and an
 * empty cell mean the same thing and both read as `undefined`.
 */
export type SheetRow = { rowNumber: number; cells: Record<string, CellValue> };

/**
 * `headers` in column order, `rows` in sheet order.
 *
 * Rows carrying no values at all are NOT returned. The real export is a
 * template: one data row followed by ~187 rows that exist only to hold a
 * currency format on two columns. Emitting those as rows would hand the batch
 * runner 187 spurious quarantines and make `rowsOk + rowsFailed === source row
 * count` (AM-04-C23) count formatting as data. A row with no value is not data.
 */
export type ParsedSheet = { headers: string[]; rows: SheetRow[] };

/**
 * The zip caps (AM-04-C34), plus the one implementation parameter that makes
 * them enforceable rather than decorative.
 *
 * Measured against the client's real export: 8,245 bytes packed → 37,023
 * unpacked, 4.5× overall, 10 entries. A 400-row export scales the worksheet
 * ~200×, so roughly 1 MB packed / 5 MB unpacked. Every cap below has two orders
 * of magnitude of headroom over that and still refuses a bomb.
 */
export type XlsxLimits = {
  /** Whole-file cap, checked before a single byte is inflated. */
  maxInputBytes: number;
  /** Sum of everything this module inflates, across both reader passes. */
  maxTotalBytes: number;
  /** Any single entry's unpacked size. */
  maxEntryBytes: number;
  /**
   * Unpacked-so-far ÷ the PACKED SIZE OF THE WHOLE FILE. Deliberately not the
   * per-entry ratio: the per-entry packed size comes from the local header,
   * which is attacker-controlled, and a bomb that overstates it would evade the
   * check. The file's own length is the one denominator we measure ourselves.
   */
  maxCompressionRatio: number;
  /** Entries the archive may contain at all (the real file has 10). */
  maxEntries: number;
  /**
   * How much of the archive is fed to the inflater per call — THE ALLOCATION
   * BOUND, and the reason the byte caps above are not a post-mortem.
   *
   * fflate's `Inflate` produces all output for a push inside `inflt()` and only
   * then calls `ondata`. So an abort inside `ondata` cannot prevent the
   * allocation of the chunk it is looking at; it can only prevent the NEXT one.
   * What bounds that chunk is how much compressed input a single push carries:
   * deflate's maximum expansion is ~1032:1, and measured against fflate 0.8.3 a
   * 4,096-byte push of a zeros bomb produced 4,132,129 bytes — 1009×. At 16 KiB
   * the worst case is therefore ~16.5 MB, whatever the entry's real size.
   *
   * Push the whole archive in one call and that bound becomes the entry's full
   * unpacked size: a 1 GB entry is allocated in full before `ondata` is reached
   * even once. Verified — one `push(data, true)` of an 8 MB bomb yielded a
   * single 8,388,608-byte `ondata` chunk.
   *
   * THIS DOES NOT MAKE THE CUMULATIVE ABORT REDUNDANT, and that is the one
   * thing to take from this docblock. "The push size is what bounds it, not the
   * abort" is true of PEAK-PER-PUSH and false of TOTAL: this constant caps a
   * single inflate call at ~16.5 MB, but 640 such pushes of a 10 MB archive
   * still reach ~10 GB. The push size is what makes the abort TIMELY; the
   * running byte count in `ondata` is what makes the total BOUNDED. Delete
   * either and the caps stop holding — for different inputs, which is why one
   * test cannot cover both:
   *
   *   - this constant is guarded by the shipped-default bomb test, which needs
   *     a fixture LARGER than one push's worst case (48 MB, not 4 MB — a 4 MB
   *     entry fits inside a single push and its abort cannot be partial);
   *   - the cumulative abort is guarded by the lowered-push variant.
   */
  pushChunkBytes: number;
};

/** The ruled values (design §7.2). Production callers pass no overrides. */
export const XLSX_LIMITS: XlsxLimits = {
  maxInputBytes: 10 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntries: 64,
  pushChunkBytes: 16 * 1024,
};

const WORKBOOK_ENTRY = "xl/workbook.xml";
const WORKBOOK_RELS_ENTRY = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS_ENTRY = "xl/sharedStrings.xml";

/** Read first, because the worksheet's name is not knowable without them. */
const MANIFEST_ENTRIES: ReadonlySet<string> = new Set([
  WORKBOOK_ENTRY,
  WORKBOOK_RELS_ENTRY,
  SHARED_STRINGS_ENTRY,
]);

/** Cell `t` values this reader understands. Absent means bare numeric. */
const SHARED_STRING_TYPE = "s";

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

/** Carried across both passes so the total cap covers the run, not a pass. */
type InflateBudget = { totalInflated: number };

/**
 * One streaming pass over the archive, inflating only `wanted`.
 *
 * Entries outside `wanted` never have `start()` called, so fflate buffers their
 * COMPRESSED bytes and never expands them — bounded by `maxInputBytes` for
 * free. That allowlist is the weaker of the two layers though, and deliberately
 * so: an attacker who controls the file simply names the bomb
 * `xl/worksheets/sheet1.xml`, which IS wanted. The byte counting below is what
 * survives that, and the two-variant fixture in the test file is what proves
 * both layers separately.
 *
 * The entry-count cap is checked per pass rather than across the run. Both
 * passes walk the same archive and therefore see the same count, so the verdict
 * is identical either way; accumulating it would just make the second pass fail
 * at half the stated cap.
 */
function inflateEntries(
  data: Uint8Array,
  wanted: ReadonlySet<string>,
  limits: XlsxLimits,
  budget: InflateBudget,
): Map<string, Uint8Array> {
  const found = new Map<string, Uint8Array>();
  const ratioCeiling = data.length * limits.maxCompressionRatio;
  let entries = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    entries += 1;
    if (entries > limits.maxEntries) {
      throw new Error(
        `Import file holds more than ${limits.maxEntries} entries — refusing to read it.`,
      );
    }
    if (!wanted.has(file.name)) return;

    // The local header's declared size, when the producer wrote one. Excel
    // does; fflate's own zipSync does too. It is attacker-controlled and so is
    // NOT the defence — it is a free refusal that costs zero allocation when
    // the file is honest about being enormous.
    // Dropping the undefined check is equivalent (`undefined > n` is false
    // either way), and > vs >= is the same megabyte-threshold argument as in
    // `ondata`. Kept on ONE line so the directive can reach it: `disable
    // next-line` covers the next LINE, and a condition wrapped across three
    // lines puts its mutants out of that reach entirely — the same
    // fails-silently-and-flatters-the-score trap as a misplaced `restore`
    // (LEARNINGS §Tooling).
    const declared = file.originalSize;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: see above
    if (declared !== undefined && declared > limits.maxEntryBytes) {
      throw new Error(
        `Import file entry "${file.name}" declares ${declared} bytes, ` +
          // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
          `past the ${limits.maxEntryBytes}-byte per-entry limit.`,
      );
    }

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      entryBytes += chunk.length;
      budget.totalInflated += chunk.length;
      // The three caps below are `>` rather than `>=` — a file is refused for
      // EXCEEDING a cap, not for reaching it. Mutation testing cannot tell the
      // two apart here and no test in this file tries to: constructing an
      // archive that inflates to a byte-exact 64 MB would need test-only
      // surface inside this loop, and a one-byte difference at that threshold
      // changes nothing about what the cap defends. `maxEntries` is a small
      // integer where the boundary IS observable, and it is pinned.
      // Stryker disable next-line EqualityOperator: see above — no file can distinguish > from >= at a megabyte threshold
      if (entryBytes > limits.maxEntryBytes) {
        throw new Error(
          // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
          `Import file entry "${file.name}" expands past the ` +
            `${limits.maxEntryBytes}-byte per-entry limit ` +
            `(aborted after ${entryBytes} bytes).`,
        );
      }
      // Stryker disable next-line EqualityOperator: as above
      if (budget.totalInflated > limits.maxTotalBytes) {
        throw new Error(
          `Import file expands past the ${limits.maxTotalBytes}-byte total limit ` +
            // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
            `(aborted after ${budget.totalInflated} bytes).`,
        );
      }
      // Stryker disable next-line EqualityOperator: as above
      if (budget.totalInflated > ratioCeiling) {
        throw new Error(
          `Import file expands more than ${limits.maxCompressionRatio}× its ` +
            `packed size (aborted after ${budget.totalInflated} bytes).`,
        );
      }
      chunks.push(chunk);
      // Stryker disable next-line ConditionalExpression: forcing this true is equivalent — a non-final chunk writes a correct partial and the final one overwrites it
      if (final) found.set(file.name, concatChunks(chunks, entryBytes));
    };
    file.start();
  };

  for (let at = 0; at < data.length; at += limits.pushChunkBytes) {
    const end = Math.min(at + limits.pushChunkBytes, data.length);
    // Never signalling `final` is only observable on a TRUNCATED archive, where
    // the entry then fails to complete and the missing-entry throw catches it.
    // Stryker disable next-line ConditionalExpression: see above
    unzip.push(data.subarray(at, end), end === data.length);
  }
  return found;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function requireEntry(
  entries: Map<string, Uint8Array>,
  name: string,
): Uint8Array {
  const bytes = entries.get(name);
  if (!bytes) {
    throw new Error(`Import file is missing "${name}" — not a readable .xlsx.`);
  }
  return bytes;
}

/**
 * `fatal` so a mis-encoded part fails loudly instead of decoding to U+FFFD and
 * landing in the register as mojibake nobody can correct afterwards.
 *
 * Built per call rather than once at module scope. A module-level instance is a
 * STATIC initialiser: it is evaluated when the module is first imported, which
 * under a cached module registry can be before a test has had any chance to
 * influence it — so a change to these arguments is unobservable to a test that
 * imports the module normally. Four short-lived decoders per parse cost nothing
 * and keep the encoding choice inside the code path that depends on it.
 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

// ---------------------------------------------------------------------------
// XML scanning
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Expand the five predefined references and numeric character references.
 *
 * Anything else throws. That is the fail-closed half of the no-XML-parser
 * choice: a `&bomb;` is neither expanded (the billion-laughs attack) nor passed
 * through as the literal text `&bomb;` (silent corruption of a value we are
 * about to write to the register).
 */
function decodeXmlText(raw: string): string {
  return raw.replace(/&([^;&\s]+);/g, (whole, body: string) => {
    const named = XML_ENTITIES[body];
    if (named !== undefined) return named;
    // The two forms XML actually defines, kept apart. Sharing one hex-ish
    // character class between them looks tidier and is wrong: `&#65a;` would
    // match, `Number.parseInt("65a", 10)` would stop at the first non-digit and
    // return 65, and a malformed entity would decode to "A" without a word.
    // Anchored at both ends for the same reason — unanchored, a body like
    // `a#65` would decode around the junk instead of being refused.
    const numeric = /^#(?:([0-9]+)|x([0-9a-fA-F]+))$/.exec(body);
    if (numeric) {
      const code =
        numeric[1] === undefined
          ? Number.parseInt(numeric[2], 16)
          : Number.parseInt(numeric[1], 10);
      // Only the upper bound is checked. Both branches admit digits alone, so
      // the value can be neither negative nor NaN, and guarding against either
      // would be defending a case that cannot arise.
      if (code <= 0x10ffff) return String.fromCodePoint(code);
    }
    throw new Error(
      `Import file contains an unsupported XML entity "${whole}" — refusing to read it.`,
    );
  });
}

type XmlElement = {
  /** Raw attribute text, leading whitespace included. */
  attrs: string;
  /** `null` for a self-closing element. */
  body: string | null;
};

/**
 * Yield every `<name …>…</name>` and `<name …/>` in document order.
 *
 * Sound only for elements that cannot contain themselves — `row`, `c`, `v`,
 * `si`, `t`, `sheet`, `Relationship` — which is every element this module
 * scans. It is not, and must not become, a general parser.
 */
function* scanElements(
  xml: string,
  name: string,
): Generator<XmlElement, void, undefined> {
  // `[^>]*?` is lazy so that the `/` of a self-closing tag is matched by the
  // second group rather than swallowed into the attribute text.
  const open = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, "g");
  const close = `</${name}>`;
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    // Any default here behaves the same: `attr()` regex-searches this text and
    // an element with no attributes has nothing to find whatever it holds.
    // Stryker disable next-line StringLiteral: see above
    const attrs = match[1] ?? "";
    if (match[2] === "/") {
      yield { attrs, body: null };
      continue;
    }
    const bodyStart = open.lastIndex;
    const bodyEnd = xml.indexOf(close, bodyStart);
    if (bodyEnd === -1) {
      throw new Error(`Import file has an unclosed <${name}> element.`);
    }
    yield { attrs, body: xml.slice(bodyStart, bodyEnd) };
    // Resuming before the close tag instead of after it finds the same next
    // element: a close tag cannot itself match an open tag.
    // Stryker disable next-line ArithmeticOperator: see above
    open.lastIndex = bodyEnd + close.length;
  }
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}=("|')(.*?)\\1`).exec(attrs);
  return match ? decodeXmlText(match[2]) : undefined;
}

/** The body of the first `<name>` element, or undefined if there is none. */
function firstBody(xml: string, name: string): string | undefined {
  for (const element of scanElements(xml, name)) return element.body ?? "";
  return undefined;
}

// ---------------------------------------------------------------------------
// Workbook parts
// ---------------------------------------------------------------------------

/**
 * AM-04-C36 — reject the WHOLE FILE when the 1904 date system is in force.
 *
 * A Mac-produced re-export shifts every serial by 1462 days, which is four
 * years, silently and uniformly. There is no partial recovery from importing
 * one: every purchase date would be wrong and nothing in the register would
 * look odd. Handling the shift correctly is a mapper change and a fresh consult
 * away; the fail-closed answer is to refuse the file.
 */
function assert1900DateSystem(workbookXml: string): void {
  for (const element of scanElements(workbookXml, "workbookPr")) {
    const flag = attr(element.attrs, "date1904");
    if (flag === "1" || flag === "true") {
      throw new Error(
        "Import file uses the 1904 date system — every date in it is 1462 days " +
          // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
          "off the register's epoch. Re-export it from Excel on Windows.",
      );
    }
  }
}

/**
 * AM-04-C35 — the worksheet's entry name, resolved through the rels.
 *
 * `<sheet name="Export" sheetId="1" r:id="rId1"/>` does not say where the sheet
 * lives; only `xl/_rels/workbook.xml.rels` maps `rId1` to
 * `worksheets/sheet1.xml`. Hardcoding that path reads the right entry for this
 * one file and the wrong one for any workbook whose sheets were ever reordered.
 *
 * Exactly one `<sheet>` is required. More than one and "the export" is not a
 * well-defined thing to import: picking the first would silently import
 * whichever sheet happened to sort first in a workbook somebody added a notes
 * tab to.
 */
function resolveSheetEntry(workbookXml: string, relsXml: string): string {
  const sheetsBody = firstBody(workbookXml, "sheets");
  if (sheetsBody === undefined) {
    throw new Error("Import file has no <sheets> element — not a workbook.");
  }
  const sheets = [...scanElements(sheetsBody, "sheet")];
  if (sheets.length !== 1) {
    throw new Error(
      `Import file holds ${sheets.length} sheets — the legacy export has ` +
        // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
        `exactly one, and this reader will not guess which to import.`,
    );
  }
  const relationshipId = attr(sheets[0].attrs, "r:id");
  if (!relationshipId) {
    throw new Error("Import file's <sheet> carries no r:id.");
  }

  for (const relationship of scanElements(relsXml, "Relationship")) {
    if (attr(relationship.attrs, "Id") !== relationshipId) continue;
    const type = attr(relationship.attrs, "Type");
    if (!type?.endsWith("/worksheet")) {
      throw new Error(
        `Import file's sheet relationship ${relationshipId} points at a ` +
          `"${type ?? "(none)"}" part, not a worksheet.`,
      );
    }
    const target = attr(relationship.attrs, "Target");
    if (!target) {
      throw new Error(
        `Import file's relationship ${relationshipId} has no Target.`,
      );
    }
    // String concatenation against the archive's own entry names, never a path
    // join — see the module docblock. Relationship targets in a workbook's rels
    // are relative to `xl/`.
    return `xl/${target}`;
  }
  throw new Error(
    `Import file's rels do not resolve ${relationshipId} to anything.`,
  );
}

/**
 * The shared string table, by index.
 *
 * An `<si>` is either `<si><t>text</t></si>` or, for a run-formatted cell, a
 * sequence of `<r><t>…</t></r>` whose text concatenates. Both shapes reduce to
 * "every `<t>` in document order", which is what this does.
 */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const item of scanElements(xml, "si")) {
    let text = "";
    // A self-closing `<si/>` needs no branch of its own: it has no `<t>`, so
    // the loop below runs zero times and leaves the empty string an empty
    // `<si><t/></si>` would have produced anyway. The fallback's exact value is
    // immaterial — any text with no `<t>` in it scans to nothing.
    // Stryker disable next-line StringLiteral: see above
    for (const run of scanElements(item.body ?? "", "t")) {
      // Stryker disable next-line StringLiteral: a self-closing <t/> is empty text whatever stands in for it
      text += decodeXmlText(run.body ?? "");
    }
    strings.push(text);
  }
  return strings;
}

// ---------------------------------------------------------------------------
// The worksheet
// ---------------------------------------------------------------------------

/** `"AB12"` → 27. Throws rather than guessing when the reference is absent. */
function columnIndexOf(cellRef: string | undefined, rowNumber: number): number {
  const letters = cellRef && /^([A-Z]+)\d+$/.exec(cellRef)?.[1];
  if (!letters) {
    throw new Error(
      `Import file has a cell on row ${rowNumber} with no usable r="" ` +
        // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
        `reference ("${cellRef ?? ""}") — its column cannot be resolved.`,
    );
  }
  // The absolute value is never used — only compared against another column's,
  // to line a data cell up with its heading and to order the headers. Any
  // order-preserving shift of this arithmetic is therefore invisible through
  // the public API, and a test claiming to pin it would be asserting on an
  // internal number the module deliberately does not expose.
  let index = 0;
  for (const letter of letters) {
    // Stryker disable next-line ArithmeticOperator: as above
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  // Stryker disable next-line ArithmeticOperator: as above
  return index - 1;
}

/**
 * One cell's value, or `undefined` when the cell carries none.
 *
 * AM-04-C37 — the type allowlist, and it is an ALLOWLIST with an explicit
 * throw, not a switch with a permissive default. `t="s"` and a bare numeric are
 * everything the legacy export produces; `inlineStr`, `str`, `b`, `e` and
 * `n` all reach here as a named, refused type.
 *
 * The failure this shape exists to prevent is not a crash, it is silence:
 * treating an unrecognised type as an empty cell drops the value, the row
 * imports looking complete, and nothing anywhere reports that a serial number
 * went missing. Losing data quietly is the one thing the AC forbids, so an
 * unknown type stops the file.
 *
 * `t="n"` is refused too, though it is legal OOXML and means exactly what a
 * bare numeric means. Widening the allowlist by one is a one-line change and a
 * ruling; guessing that this producer's `n` means what the spec says it means
 * is not something to do silently on a file we have never seen.
 */
function cellValue(
  cell: XmlElement,
  sharedStrings: string[],
  rowNumber: number,
  cellRef: string | undefined,
): CellValue | undefined {
  const type = attr(cell.attrs, "t");
  if (type !== undefined && type !== SHARED_STRING_TYPE) {
    throw new Error(
      `Import file cell ${cellRef ?? `on row ${rowNumber}`} has cell type ` +
        `"${type}", which this reader does not handle. Reading it as empty ` +
        // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
        `would drop the value silently, so the import stops here.`,
    );
  }
  // A self-closing `<c r="D197" s="2"/>` — the shape the template's ~187
  // trailing rows are made of — needs no branch of its own: it has no `<v>`,
  // so the lookup below returns undefined exactly as it does for a `<c>` whose
  // `<v>` is absent or empty. The fallback's value is immaterial: any text with
  // no `<v>` in it looks up to nothing.
  // Stryker disable next-line StringLiteral: see above
  const raw = firstBody(cell.body ?? "", "v");
  if (raw === undefined || raw === "") return undefined;

  if (type === SHARED_STRING_TYPE) {
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `Import file cell ${cellRef ?? `on row ${rowNumber}`} is a shared ` +
          // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
          `string whose index is "${raw}".`,
      );
    }
    const text = sharedStrings[Number(raw)];
    if (text === undefined) {
      throw new Error(
        `Import file cell ${cellRef ?? `on row ${rowNumber}`} references ` +
          // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
          `shared string ${raw}, which the table does not hold.`,
      );
    }
    // Excel keeps a `<si><t></t></si>` for a cell whose text was deleted, so a
    // cleared cell arrives as a shared string resolving to "". That is no
    // value, and it has to be reported as no value rather than as the empty
    // string: an empty tag is AM-02's recorded trap, where '' occupies the
    // unique index and the SECOND blank-tagged row reports a phantom
    // duplicate. Omitting it also keeps the promise ParsedSheet makes, that a
    // missing key and an empty cell are the same thing.
    return text === "" ? undefined : text;
  }

  // Bare numeric. Matched strictly and converted from the canonical XML text —
  // NOT parseFloat, which returns 1 for "1,229.81". The cost column arrives as
  // a shared string anyway (design F-F) and its strict decimal rule is the
  // mapper's; this is only about not letting `NaN` into the register.
  if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) {
    throw new Error(
      `Import file cell ${cellRef ?? `on row ${rowNumber}`} holds "${raw}", ` +
        // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
        `which is not a number and carries no cell type.`,
    );
  }
  return Number(raw);
}

/**
 * Row 1 names the columns; every later row is read against those names.
 *
 * AM-04-C14 / design F-E — BY NAME, NEVER BY INDEX. Columns E, G, I and N carry
 * no `<c>` element at all on the client's sample row, so the nth `<c>` in a row
 * is not the nth column, and a reader that zips cells against headers
 * positionally files the serial number under Brand. The `r=""` reference is the
 * only thing that says where a cell actually sits.
 */
function parseSheet(sheetXml: string, sharedStrings: string[]): ParsedSheet {
  const sheetData = firstBody(sheetXml, "sheetData");
  if (sheetData === undefined) {
    throw new Error("Import file's worksheet has no <sheetData>.");
  }

  const headerByColumn = new Map<number, string>();
  let headersRead = false;
  const rows: SheetRow[] = [];

  for (const row of scanElements(sheetData, "row")) {
    const rowNumber = Number(attr(row.attrs, "r"));
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      throw new Error(
        `Import file has a <row> with no usable r="" number — its position ` +
          // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
          `in the sheet cannot be reported.`,
      );
    }
    const cells: Record<string, CellValue> = {};
    // `<row r="201"/>` self-closes; with no `<c>` inside it, the loop runs zero
    // times and the row falls through as valueless, which is what it is. The
    // fallback's value is immaterial: any text with no `<c>` scans to nothing.
    // Stryker disable next-line StringLiteral: see above
    for (const cell of scanElements(row.body ?? "", "c")) {
      const cellRef = attr(cell.attrs, "r");
      const value = cellValue(cell, sharedStrings, rowNumber, cellRef);
      const column = columnIndexOf(cellRef, rowNumber);

      if (!headersRead) {
        if (value === undefined) continue;
        if (typeof value !== "string") {
          throw new Error(
            `Import file's header row has a non-text heading in cell ${cellRef}.`,
          );
        }
        const header = value.trim();
        if (header === "") continue;
        if ([...headerByColumn.values()].includes(header)) {
          throw new Error(
            `Import file's header row names "${header}" twice — one of the ` +
              // Stryker disable next-line StringLiteral: explanatory half of the message; the test pins the identifying fragment
              `two columns would be read and the other silently lost.`,
          );
        }
        headerByColumn.set(column, header);
        continue;
      }

      if (value === undefined) continue;
      const header = headerByColumn.get(column);
      if (header === undefined) {
        // A value under no heading is a value with nowhere to go. Skipping it
        // is the silent drop AM-04-C37 refuses one paragraph up; this is the
        // same refusal, one axis over.
        throw new Error(
          `Import file cell ${cellRef} carries a value in a column the header ` +
            `row does not name.`,
        );
      }
      cells[header] = value;
    }

    if (!headersRead) {
      if (headerByColumn.size === 0) continue;
      headersRead = true;
      continue;
    }
    // The template's ~187 trailing rows reach here with no values at all: they
    // exist to hold a currency format on two columns. See ParsedSheet.
    if (Object.keys(cells).length > 0) rows.push({ rowNumber, cells });
  }

  if (!headersRead) {
    throw new Error("Import file's worksheet has no header row.");
  }

  const headers = [...headerByColumn.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, header]) => header);
  return { headers, rows };
}

// ---------------------------------------------------------------------------

/**
 * Read the one sheet out of a legacy .xlsx export.
 *
 * Throws on every guard violation — there is no partial success here. Row-level
 * tolerance (quarantine one row, import the other 399) belongs to the mapper
 * and the batch runner; a file that fails one of these checks is not a file
 * with a bad row in it, it is a file we cannot read correctly at all.
 *
 * `overrides` exists for the guard tests, which lower a cap so that tripping it
 * costs kilobytes instead of gigabytes. Production callers pass nothing.
 */
export function parseAssetWorkbook(
  data: Uint8Array,
  overrides: Partial<XlsxLimits> = {},
): ParsedSheet {
  const limits = { ...XLSX_LIMITS, ...overrides };
  if (data.length > limits.maxInputBytes) {
    throw new Error(
      `Import file is ${data.length} bytes, past the ` +
        `${limits.maxInputBytes}-byte limit.`,
    );
  }

  const budget: InflateBudget = { totalInflated: 0 };
  const manifest = inflateEntries(data, MANIFEST_ENTRIES, limits, budget);
  const workbookXml = decodeUtf8(requireEntry(manifest, WORKBOOK_ENTRY));
  const relsXml = decodeUtf8(requireEntry(manifest, WORKBOOK_RELS_ENTRY));
  const sharedStrings = parseSharedStrings(
    decodeUtf8(requireEntry(manifest, SHARED_STRINGS_ENTRY)),
  );

  assert1900DateSystem(workbookXml);

  // Second pass, for the fourth and last entry. Two passes rather than one
  // because the worksheet's name is only knowable after the rels are read, and
  // the alternative — inflating every `xl/worksheets/*` and discarding the
  // wrong ones — is precisely the inflate-then-discard shape the streaming
  // abort exists to avoid. `budget` is shared, so the total cap covers the run.
  const sheetEntry = resolveSheetEntry(workbookXml, relsXml);
  const sheet = inflateEntries(data, new Set([sheetEntry]), limits, budget);
  return parseSheet(decodeUtf8(requireEntry(sheet, sheetEntry)), sharedStrings);
}
