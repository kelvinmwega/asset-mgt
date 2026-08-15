import { describe, expect, it } from "vitest";
import { AssetStatus } from "@prisma/client";
import {
  EXPECTED_HEADERS,
  IMPORT_PROBLEMS,
  excelSerialToDate,
  foldName,
  mapRow,
  mapStatus,
  missingHeaders,
  parseMoney,
} from "@/lib/import-map";

/**
 * The client's actual sample row, cell for cell (docs/features/AM-04/DESIGN.md
 * §1.1) — with the two real staff names replaced. The real export carries three
 * real people and never enters this repo; the SHAPES are what matter here and
 * they are reproduced exactly:
 *
 *   - Brand, Model, PID and Site absent entirely (sparse cells)
 *   - Purchase Date a bare NUMERIC serial
 *   - Cost a STRING in a currency-styled cell
 *   - Date Created a US-format STRING
 *   - Status "Available" while a holder is named (the F-D contradiction)
 */
const sampleRow: Record<string, string | number> = {
  "Asset Tag ID": "KE001771",
  Description: "HP USB-C G5 Essential Docking Station",
  "Purchased from": "Read technologies",
  "Purchase Date": 45177,
  Cost: "229.81",
  "Serial No": "5CG237TDXQ",
  "Asset Type": "CE",
  "City/Station": "KE02",
  CC: "CC3200",
  "P.O Number": "PO220202300331",
  Location: "IITA Nairobi ICIPE Office",
  Category: "DOCKING STATION",
  Department: "Mitigate",
  "Assigned to": "Jane Holder",
  "Date Created": "07/29/2024 07:08 AM",
  "Created by": "Sam Operator",
  Status: "Available",
};

const ok = (result: ReturnType<typeof mapRow>) => {
  if (!result.ok) {
    throw new Error(`expected a mapped row, got ${result.problem.problem}`);
  }
  return result.row;
};

const problemOf = (result: ReturnType<typeof mapRow>) => {
  if (result.ok) throw new Error("expected a quarantine, got a mapped row");
  return result.problem;
};

describe("excelSerialToDate", () => {
  // The anchor. Verified against the client's real file: 45177 is the Purchase
  // Date of the sample row and it is 8 September 2023. Epoch 1899-12-30, NOT
  // 1900-01-01 — Excel reproduces Lotus's 1900-leap-year bug.
  it("converts the client's own serial to the right day", () => {
    expect(excelSerialToDate(45177)?.toISOString()).toBe(
      "2023-09-08T00:00:00.000Z",
    );
  });

  it("floors a serial carrying a time of day", () => {
    expect(excelSerialToDate(45177.75)?.toISOString()).toBe(
      "2023-09-08T00:00:00.000Z",
    );
  });

  it("refuses serials outside a plausible range", () => {
    expect(excelSerialToDate(0)).toBeNull();
    expect(excelSerialToDate(-5)).toBeNull();
    expect(excelSerialToDate(1_000_000)).toBeNull();
    expect(excelSerialToDate(Number.NaN)).toBeNull();
    expect(excelSerialToDate(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseMoney", () => {
  it("keeps the value exact, as a string", () => {
    expect(parseMoney("229.81")).toBe("229.81");
    expect(parseMoney(229.81)).toBe("229.81");
    expect(parseMoney("0")).toBe("0");
  });

  it("treats a blank cell as absent, not as zero", () => {
    expect(parseMoney(undefined)).toBeNull();
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("   ")).toBeNull();
  });

  // THE 1000× BUG. parseFloat("1,229.81") is 1 — it stops at the comma and
  // returns a number that is both plausible and catastrophically wrong, in a
  // column the finance export is built on. Refusing beats truncating, and
  // stripping the comma would mean guessing whether "1,229" is one thousand
  // two hundred or a locale writing 1.229.
  it("refuses a thousands separator rather than truncating it", () => {
    expect(Number.parseFloat("1,229.81")).toBe(1); // the bug, pinned
    expect(parseMoney("1,229.81")).toBeUndefined();
  });

  it("refuses currency symbols, signs and free text", () => {
    for (const bad of ["$229.81", "KES 229.81", "-5", "1e3", "abc", "229."]) {
      expect(parseMoney(bad), bad).toBeUndefined();
    }
  });

  it("refuses more precision than the column can hold", () => {
    // Decimal(12,2). Accepting a third place would silently round on write.
    expect(parseMoney("229.811")).toBeUndefined();
  });
});

describe("mapStatus", () => {
  it("maps the vocabulary case- and space-insensitively", () => {
    expect(mapStatus("Available")).toBe(AssetStatus.IN_STOCK);
    expect(mapStatus("  aVaIlAbLe ")).toBe(AssetStatus.IN_STOCK);
    expect(mapStatus("Checked  Out")).toBe(AssetStatus.ASSIGNED);
    expect(mapStatus("Under Repair")).toBe(AssetStatus.IN_REPAIR);
    expect(mapStatus("Disposed")).toBe(AssetStatus.RETIRED);
    expect(mapStatus("On Order")).toBe(AssetStatus.ON_ORDER);
  });

  // Both branches, because per the advisor the MISSING-value case is the one
  // that bites: a permissive default files every blank-status row as IN_STOCK
  // and the import reports success.
  it("returns undefined for an unrecognised status", () => {
    expect(mapStatus("Leased")).toBeUndefined();
  });

  it("returns undefined for an absent or blank status", () => {
    expect(mapStatus(undefined)).toBeUndefined();
    expect(mapStatus("")).toBeUndefined();
    expect(mapStatus("   ")).toBeUndefined();
  });

  // Lost kit is NOT retired kit. Retired means disposed of deliberately; a
  // stolen laptop filed as retired stops being chased. These must quarantine
  // until the client's real vocabulary is known.
  it("does not map Lost, Missing or Stolen onto RETIRED", () => {
    for (const value of ["Lost", "Missing", "Stolen", "Lost/Missing"]) {
      expect(mapStatus(value), value).toBeUndefined();
    }
  });
});

describe("foldName", () => {
  it("folds case and collapses whitespace for matching", () => {
    expect(foldName("  Jane   HOLDER ")).toBe("jane holder");
    expect(foldName("Jane Holder")).toBe(foldName("jane  holder"));
  });
});

describe("missingHeaders", () => {
  it("accepts the export's own header row", () => {
    expect(missingHeaders([...EXPECTED_HEADERS])).toEqual([]);
  });

  it("names what is missing", () => {
    const short = EXPECTED_HEADERS.filter((h) => h !== "Status");
    expect(missingHeaders([...short])).toEqual(["Status"]);
  });

  // The legacy register's export options add columns; rejecting a file for carrying
  // more than we read would block a cutover for no safety gain.
  it("tolerates extra columns", () => {
    expect(missingHeaders([...EXPECTED_HEADERS, "Warranty"])).toEqual([]);
  });

  it("does not care about column order", () => {
    expect(missingHeaders([...EXPECTED_HEADERS].reverse())).toEqual([]);
  });
});

describe("mapRow", () => {
  it("maps the client's own sample row", () => {
    const row = ok(mapRow(2, sampleRow));

    expect(row.tag).toBe("KE001771");
    expect(row.description).toBe("HP USB-C G5 Essential Docking Station");
    expect(row.purchasePrice).toBe("229.81");
    expect(row.purchasedAt?.toISOString()).toBe("2023-09-08T00:00:00.000Z");
    expect(row.serial).toBe("5CG237TDXQ");
    expect(row.poNumber).toBe("PO220202300331");
    expect(row.costCentre).toBe("CC3200");
    expect(row.department).toBe("Mitigate");
    expect(row.categoryName).toBe("DOCKING STATION");
    expect(row.status).toBe(AssetStatus.IN_STOCK);
  });

  // F-A: the identity is in Description, and make/model really are absent.
  it("leaves make and model null when Brand and Model are absent", () => {
    const row = ok(mapRow(2, sampleRow));
    expect(row.make).toBeNull();
    expect(row.model).toBeNull();
  });

  // C17. The obvious reading of City/Station as the site would name the
  // client's PERMANENT site rows "KE02" and throw away the only human-readable
  // place in the row.
  it("takes the site from Location, not from City/Station", () => {
    const row = ok(mapRow(2, sampleRow));
    expect(row.siteName).toBe("IITA Nairobi ICIPE Office");
    expect(row.siteName).not.toBe("KE02");
    expect(row.location).toBe("IITA Nairobi ICIPE Office");
  });

  it("prefers the export's own Site column when it is populated", () => {
    const row = ok(mapRow(2, { ...sampleRow, Site: "Nairobi HQ" }));
    expect(row.siteName).toBe("Nairobi HQ");
  });

  // F-D. The legacy register keeps the last assignee after check-in, so the name is a
  // HISTORY field there and a STATE field here. Carrying it over would put a
  // named person on the hook for kit they returned.
  it("keeps the holder name for a row whose status is not ASSIGNED", () => {
    const row = ok(mapRow(2, sampleRow));
    expect(row.status).toBe(AssetStatus.IN_STOCK);
    expect(row.assigneeName).toBe("Jane Holder");
  });

  describe("quarantines", () => {
    it("a row with no tag — it has no idempotency key", () => {
      for (const tag of [undefined, "", "   "]) {
        const cells = { ...sampleRow, "Asset Tag ID": tag as string };
        expect(problemOf(mapRow(9, cells)).problem).toBe(
          IMPORT_PROBLEMS.NO_TAG,
        );
      }
    });

    it("an unrecognised status, quoting the source value", () => {
      const problem = problemOf(mapRow(9, { ...sampleRow, Status: "Leased" }));
      expect(problem.problem).toBe(IMPORT_PROBLEMS.UNKNOWN_STATUS);
      expect(problem.detail).toBe("Leased");
      expect(problem.sourceRow).toBe(9);
    });

    it("a blank status, distinctly from an unrecognised one", () => {
      const problem = problemOf(mapRow(9, { ...sampleRow, Status: "" }));
      expect(problem.problem).toBe(IMPORT_PROBLEMS.UNKNOWN_STATUS);
      expect(problem.detail).toBe("(blank)");
    });

    it("a price that would silently truncate", () => {
      const problem = problemOf(mapRow(9, { ...sampleRow, Cost: "1,229.81" }));
      expect(problem.problem).toBe(IMPORT_PROBLEMS.BAD_PRICE);
    });

    // C12: a STRING date is refused, never locale-guessed. "07/29/2024" is
    // month-first only if you already know the export's locale.
    it("a date that arrives as a string rather than a serial", () => {
      const problem = problemOf(
        mapRow(9, { ...sampleRow, "Purchase Date": "07/29/2024" }),
      );
      expect(problem.problem).toBe(IMPORT_PROBLEMS.BAD_DATE);
      expect(problem.detail).toBe("07/29/2024");
    });

    it("an ASSIGNED row with no holder named", () => {
      const problem = problemOf(
        mapRow(9, { ...sampleRow, Status: "Checked Out", "Assigned to": "" }),
      );
      expect(problem.problem).toBe(IMPORT_PROBLEMS.ASSIGNED_WITHOUT_HOLDER);
    });

    it("reports no personal data in the problem detail", () => {
      // C6: the report is persisted, and it carries no names. The holder
      // problems therefore carry no detail at all — the source row number is
      // how the operator finds the row in their own spreadsheet.
      const problem = problemOf(
        mapRow(9, { ...sampleRow, Status: "Checked Out", "Assigned to": "" }),
      );
      expect(JSON.stringify(problem)).not.toContain("Jane");
      expect(problem.detail).toBeUndefined();
    });
  });

  it("accepts an ASSIGNED row that does name a holder", () => {
    const row = ok(mapRow(2, { ...sampleRow, Status: "Checked Out" }));
    expect(row.status).toBe(AssetStatus.ASSIGNED);
    expect(row.assigneeName).toBe("Jane Holder");
  });

  // C7: neither column reaches a MappedRow, so neither can reach the database
  // or the persisted report by accident.
  it("imports neither Created by nor Date Created", () => {
    const row = ok(mapRow(2, sampleRow));
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("Sam Operator");
    expect(serialised).not.toContain("07/29/2024");
  });

  // C4: an unexplained code that gets rendered, exported and depended upon is
  // worse than no column.
  it("imports neither PID nor Asset Type", () => {
    const row = ok(mapRow(2, sampleRow));
    expect(JSON.stringify(row)).not.toContain("CE");
    expect("assetType" in row).toBe(false);
    expect("pid" in row).toBe(false);
  });
});
