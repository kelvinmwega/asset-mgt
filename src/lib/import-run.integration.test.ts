// @vitest-environment node
//
// AM-04 DESIGN §10. The properties here cannot be mocked: that a dry run leaves
// the database untouched, that a re-run adds nothing, and that the reconciliation
// totals actually add up against real inserts.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AssetStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { singleConnectionUrl } from "../../test/session-lock-client";
import { IMPORT_PROBLEMS } from "@/lib/import-map";
import {
  ImportFileError,
  hashRows,
  runImport,
  type ParsedSheet,
} from "@/lib/import-run";
import { EXPECTED_HEADERS } from "@/lib/import-map";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("import run (real DB)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    execSync("pnpm exec prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
    db = new PrismaClient({
      datasourceUrl: singleConnectionUrl(testDatabaseUrl),
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const stem = () => randomUUID().slice(0, 8).toUpperCase();

  /** One export row in the client's real shape — sparse, serial date, text cost. */
  function cells(overrides: Record<string, string | number> = {}) {
    return {
      "Asset Tag ID": `RUN-${randomUUID().slice(0, 10)}`,
      Description: "HP USB-C G5 Essential Docking Station",
      "Purchased from": "Read technologies",
      "Purchase Date": 45177,
      Cost: "229.81",
      "Serial No": `SER-${randomUUID().slice(0, 8)}`,
      "Asset Type": "CE",
      "City/Station": "KE02",
      CC: "CC3200",
      "P.O Number": "PO220202300331",
      Location: `Site ${stem()}`,
      Category: `Cat ${stem()}`,
      Department: "Mitigate",
      "Date Created": "07/29/2024 07:08 AM",
      "Created by": "Sam Operator",
      Status: "Available",
      ...overrides,
    };
  }

  const sheetOf = (rows: Record<string, string | number>[]): ParsedSheet => ({
    headers: [...EXPECTED_HEADERS],
    rows: rows.map((cellSet, index) => ({
      rowNumber: index + 2,
      cells: cellSet,
    })),
  });

  const bytes = () => new Uint8Array([1, 2, 3]);

  const dry = (sheet: ParsedSheet) =>
    runImport(db, sheet, bytes(), { commit: false });
  const commit = (sheet: ParsedSheet) =>
    runImport(db, sheet, bytes(), { commit: true });

  describe("dry run", () => {
    it("writes NOTHING, while reporting what it would write", async () => {
      const sheet = sheetOf([cells(), cells()]);
      const before = await db.asset.count();

      const result = await dry(sheet);

      expect(result.report.imported).toBe(2);
      expect(await db.asset.count()).toBe(before);
      // The reference rows it said it would create must not exist either.
      for (const name of result.report.newCategories) {
        expect(await db.category.findUnique({ where: { name } })).toBeNull();
      }
    });

    // The bug this file caught before it shipped: each row's transaction rolls
    // back, so caching a created id hands the NEXT row a foreign key that no
    // longer exists. A single-row dry run passes either way; two rows sharing a
    // new category is what exposes it.
    it("handles many rows sharing one new category and one new holder", async () => {
      const category = `Shared Cat ${stem()}`;
      const holder = `Shared Holder ${stem()}`;
      const sheet = sheetOf([
        cells({
          Category: category,
          Status: "Checked Out",
          "Assigned to": holder,
        }),
        cells({
          Category: category,
          Status: "Checked Out",
          "Assigned to": holder,
        }),
        cells({
          Category: category,
          Status: "Checked Out",
          "Assigned to": holder,
        }),
      ]);

      const result = await dry(sheet);

      expect(result.report.quarantined).toBe(0);
      expect(result.report.imported).toBe(3);
      // Counted per HUMAN and per NAME, not per row — three assets held by one
      // person is one person to create.
      expect(result.report.holders.created).toBe(1);
      expect(result.report.newCategories).toEqual([category]);
      expect(await db.person.count({ where: { name: holder } })).toBe(0);
    });

    it("reports the reference census the operator has to sign", async () => {
      const category = `Census Cat ${stem()}`;
      const site = `Census Site ${stem()}`;
      const result = await dry(
        sheetOf([cells({ Category: category, Location: site })]),
      );

      expect(result.report.newCategories).toEqual([category]);
      expect(result.report.newSites).toEqual([site]);
    });
  });

  describe("commit", () => {
    it("imports, and a re-run of the same file adds nothing", async () => {
      const sheet = sheetOf([cells(), cells()]);

      const first = await commit(sheet);
      expect(first.report.imported).toBe(2);

      const again = await commit(sheet);
      expect(again.report.imported).toBe(0);
      expect(again.report.skipped).toBe(2);

      // Insert-only: no second asset, and no UPDATED event claiming a change
      // nobody made.
      for (const outcome of again.report.outcomes) {
        if (outcome.kind !== "skipped") continue;
        const asset = await db.asset.findUniqueOrThrow({
          where: { tag: outcome.tag },
          include: { events: true },
        });
        expect(asset.events).toHaveLength(1);
        expect(asset.events[0].type).toBe("IMPORTED");
      }
    });

    it("reports a changed row as a CONFLICT and does not overwrite it", async () => {
      const row = cells();
      await commit(sheetOf([row]));

      const edited = { ...row, Description: "Edited by hand in the app" };
      const result = await commit(sheetOf([edited]));

      expect(result.report.conflicted).toBe(1);
      const conflict = result.report.outcomes.find(
        (outcome) => outcome.kind === "conflict",
      );
      expect(conflict).toMatchObject({ fields: ["description"] });
      // The admin's edit survives — the import does not revert it.
      const asset = await db.asset.findUniqueOrThrow({
        where: { tag: String(row["Asset Tag ID"]) },
      });
      expect(asset.description).toBe("HP USB-C G5 Essential Docking Station");
    });

    // ONE FIELD PER CASE, all nine. The suite previously exercised only
    // `description`, which left the StringLiteral mutant on every other entry
    // of CONFLICT_FIELDS unfalsifiable: delete `serial` from the array and a
    // changed serial reports as SKIPPED, the admin is never told the source
    // disagrees, and C20's promise quietly stops holding for that column.
    //
    // The cell header differs from the model field for most of them, which is
    // itself worth pinning — this is the mapping the export actually uses.
    it.each([
      ["description", "Description", "A different description"],
      ["make", "Brand", "Lenovo"],
      ["model", "Model", "ThinkPad X1"],
      ["serial", "Serial No", "CHANGED-SERIAL"],
      ["supplier", "Purchased from", "A different supplier"],
      ["poNumber", "P.O Number", "PO-CHANGED"],
      ["costCentre", "CC", "CC9999"],
      ["department", "Department", "A different department"],
      ["location", "Location", "A different location"],
    ])("reports a changed %s as a conflict", async (field, header, value) => {
      const row = cells();
      await commit(sheetOf([row]));

      const result = await commit(sheetOf([{ ...row, [header]: value }]));

      expect(result.report.conflicted).toBe(1);
      const conflict = result.report.outcomes.find(
        (outcome) => outcome.kind === "conflict",
      );
      expect(conflict?.kind === "conflict" && conflict.fields).toContain(field);
      // Insert-only: reported, never written.
      const asset = await db.asset.findUniqueOrThrow({
        where: { tag: String(row["Asset Tag ID"]) },
      });
      expect(asset[field as keyof typeof asset]).not.toBe(value);
    });

    // THE SECOND ONE-WAY DOOR, and it had no test at all. Reference rows are
    // renamed but never removed and a rename CANNOT MERGE, so importing
    // "Docking Station" and "DOCKING STATION" as two categories splits the
    // register permanently.
    //
    // The guard is `.trim().toLowerCase()` at three sites — the resolveReference
    // key and both cache builders. Every fixture in this file used
    // `Cat ${stem()}` with stem() returning uppercase hex, so NO fixture varied
    // case or whitespace and all six mutants survived. That is the AM-02
    // recurrence the learnings name: a `.trim()` whose only whitespace test was
    // pre-trimmed a layer up.
    it("folds case and whitespace when matching Category and Site", async () => {
      const category = `Docking Station ${stem()}`;
      const site = `Nairobi Office ${stem()}`;

      const result = await commit(
        sheetOf([
          cells({ Category: category, Location: site }),
          // Same two names to a human, and the only difference the guard sees.
          cells({
            Category: `  ${category.toUpperCase()}  `,
            Location: `  ${site.toLowerCase()}  `,
          }),
        ]),
      );

      expect(result.report.imported).toBe(2);
      // ONE row each, not two. This is the assertion the whole guard exists for.
      expect(
        await db.category.count({
          where: { name: { equals: category, mode: "insensitive" } },
        }),
      ).toBe(1);
      expect(
        await db.site.count({
          where: { name: { equals: site, mode: "insensitive" } },
        }),
      ).toBe(1);
      // The census reports ONE creation, not two — the operator signs off a
      // list of what will be created, and a doubled entry there is the visible
      // symptom of this bug.
      expect(result.report.newCategories).toHaveLength(1);
      expect(result.report.newSites).toHaveLength(1);
    });

    // The cache builders trim what they read OUT of the database, which is a
    // different guard from trimming the incoming cell — and it survived the
    // test above because every write path we control already trims (the
    // mapper's blankToNull, the admin action, the seed script), so no stored
    // name carries whitespace today.
    //
    // It is kept rather than deleted as dead code, deliberately. It defends a
    // ONE-WAY DOOR: reference rows are renamed but never removed and a rename
    // cannot merge, so a single untrimmed stored name — from a future write
    // path, a migration, or direct SQL — would split a category permanently.
    // Deleting defensive normalisation on that path to satisfy a mutation score
    // is the wrong trade. This makes it falsifiable instead.
    it("matches a stored reference name that carries whitespace", async () => {
      const category = `Legacy Padded ${stem()}`;
      // However it got there — this is the state, not the route to it.
      await db.category.create({ data: { name: `  ${category}  ` } });

      const result = await commit(sheetOf([cells({ Category: category })]));

      expect(result.report.imported).toBe(1);
      // Matched the existing row rather than creating a second one.
      expect(result.report.newCategories).toEqual([]);
      expect(
        await db.category.count({
          where: { name: { contains: category } },
        }),
      ).toBe(1);
    });

    // The COMMIT path through the reference cache, which the dry-run test
    // cannot reach: `cells()` mints a fresh category per call, so
    // `sheetOf([cells(), cells()])` is two distinct categories and `if (hit)`
    // is never taken on a committing run.
    it("reuses a category it created earlier in the same commit run", async () => {
      const category = `Shared Commit Cat ${stem()}`;

      const result = await commit(
        sheetOf([cells({ Category: category }), cells({ Category: category })]),
      );

      expect(result.report.imported).toBe(2);
      expect(await db.category.count({ where: { name: category } })).toBe(1);
      expect(result.report.newCategories).toEqual([category]);
    });

    it("imports a legacy ASSIGNED row with its holder", async () => {
      const holder = `Legacy Holder ${stem()}`;
      const result = await commit(
        sheetOf([cells({ Status: "Checked Out", "Assigned to": holder })]),
      );

      expect(result.report.imported).toBe(1);
      expect(result.report.holders.created).toBe(1);

      const person = await db.person.findFirstOrThrow({
        where: { name: holder },
        include: { assignments: { include: { asset: true } } },
      });
      expect(person.email).toBeNull();
      expect(person.assignments).toHaveLength(1);
      expect(person.assignments[0].returnedAt).toBeNull();
      expect(person.assignments[0].asset.status).toBe(AssetStatus.ASSIGNED);
      // Back-dated from the source, not stamped with the cutover date.
      expect(person.assignments[0].checkedOutAt.toISOString()).toBe(
        "2023-09-08T00:00:00.000Z",
      );
    });

    // AM-04-C44, and the client's OWN sample row: Status "Available" with a
    // holder named. Asset Tiger keeps the last assignee after check-in, so the
    // name is history there and custody here. Opening an assignment would
    // create `strandedOpen` — the second half of the README reconciliation
    // query — which can only ever be closed by fabricating a return.
    it("imports an unassigned row that names a holder, WITHOUT an assignment", async () => {
      const holder = `Discarded Holder ${stem()}`;
      const row = cells({ Status: "Available", "Assigned to": holder });

      const result = await commit(sheetOf([row]));

      expect(result.report.imported).toBe(1);
      const asset = await db.asset.findUniqueOrThrow({
        where: { tag: String(row["Asset Tag ID"]) },
        include: { assignments: true },
      });
      expect(asset.status).toBe(AssetStatus.IN_STOCK);
      // The invariant: an open assignment IF AND ONLY IF status is ASSIGNED.
      expect(asset.assignments).toHaveLength(0);
      // …and no stub person invented for someone who is not holding anything.
      expect(await db.person.count({ where: { name: holder } })).toBe(0);
    });

    it("REPORTS the discarded holder rather than dropping it silently", async () => {
      const row = cells({
        Status: "Available",
        "Assigned to": `Reported Holder ${stem()}`,
      });

      const result = await commit(sheetOf([row]));

      expect(result.report.holders.discarded).toBe(1);
      expect(result.report.discardedHolderRows).toEqual([2]);
      // By ROW NUMBER only — the persisted report carries no names (C6).
      expect(JSON.stringify(result.report)).not.toContain("Reported Holder");
    });

    it("quarantines an ambiguous holder without importing the asset", async () => {
      const name = `Twin ${stem()}`;
      await db.person.create({ data: { name, email: null } });
      await db.person.create({ data: { name, email: null } });

      const row = cells({ Status: "Checked Out", "Assigned to": name });
      const result = await commit(sheetOf([row]));

      expect(result.report.quarantined).toBe(1);
      expect(result.report.problems[IMPORT_PROBLEMS.AMBIGUOUS_HOLDER]).toBe(1);
      // The whole row rolled back — no orphan asset with no holder.
      expect(
        await db.asset.findUnique({
          where: { tag: String(row["Asset Tag ID"]) },
        }),
      ).toBeNull();
      expect(await db.person.count({ where: { name } })).toBe(2);
    });

    it("keeps importing after a quarantined row", async () => {
      // The reason quarantine beats fail-fast: one bad row must not block 399.
      const good = cells();
      const result = await commit(
        sheetOf([cells({ Status: "Leased" }), good, cells({ Status: "" })]),
      );

      expect(result.report.imported).toBe(1);
      expect(result.report.quarantined).toBe(2);
      expect(result.report.problems[IMPORT_PROBLEMS.UNKNOWN_STATUS]).toBe(2);
      expect(
        await db.asset.findUnique({
          where: { tag: String(good["Asset Tag ID"]) },
        }),
      ).not.toBeNull();
    });

    it("quarantines a tag repeated inside the file", async () => {
      const tag = `DUP-${randomUUID().slice(0, 10)}`;
      const result = await commit(
        sheetOf([
          cells({ "Asset Tag ID": tag }),
          cells({ "Asset Tag ID": tag }),
        ]),
      );

      expect(result.report.imported).toBe(1);
      // Reported as a source-data problem, NOT as "already imported" — which is
      // what the unique index alone would have made it look like.
      expect(
        result.report.problems[IMPORT_PROBLEMS.DUPLICATE_TAG_IN_FILE],
      ).toBe(1);
    });
  });

  describe("reconciliation and file-level failures", () => {
    // AM-04-C23, with its premise guarded: a fixture where everything succeeds
    // would make 0 failures pass vacuously, so this one deliberately contains
    // both.
    it("accounts for every source row exactly once", async () => {
      const sheet = sheetOf([
        cells(),
        cells({ Status: "Leased" }),
        cells({ "Asset Tag ID": "" }),
        cells(),
      ]);

      const { report } = await commit(sheet);

      expect(report.sourceRowCount).toBeGreaterThan(0);
      expect(report.quarantined).toBeGreaterThan(0);
      expect(
        report.imported +
          report.skipped +
          report.conflicted +
          report.quarantined,
      ).toBe(report.sourceRowCount);
      expect(report.outcomes).toHaveLength(report.sourceRowCount);
    });

    it("fails the whole file when a header is missing", async () => {
      const sheet = sheetOf([cells()]);
      sheet.headers = sheet.headers.filter((header) => header !== "Status");

      await expect(dry(sheet)).rejects.toThrow(ImportFileError);
    });

    it("persists no personal data in the report", async () => {
      // AM-04-C6, head-on. The name is in the source and in the in-flight
      // sign-off list; it must not be in the object that reaches ImportBatch.
      const name = `Jane Reportable ${stem()}`;
      const result = await commit(
        sheetOf([cells({ Status: "Checked Out", "Assigned to": name })]),
      );

      expect(JSON.stringify(result.report)).not.toContain("Jane Reportable");
      expect(JSON.stringify(result.report)).not.toContain("Sam Operator");
      // …while the operator's own sign-off list DOES carry it, because that is
      // printed and never stored.
      expect(result.holderSignOff.map((entry) => entry.name)).toContain(name);
    });
  });

  describe("hashRows", () => {
    // GOLDEN VALUE (AM-04-C42). The dry-run/commit binding is this digest: if
    // what hashRows computes ever changes, every previously signed-off batch id
    // stops matching its own file and --commit refuses for reasons nobody can
    // diagnose. Pinning a literal is the only assertion that catches a change
    // to the ALGORITHM as opposed to a change in the data.
    //
    // Paired with the fix that turned the raw 0x00-0x03 delimiters into \u
    // escapes: this exact digest was captured BEFORE that change and is
    // asserted after, which is what proves the two are byte-identical at
    // runtime rather than merely believed to be.
    it("computes a known digest for a fixed sheet", () => {
      const fixed: ParsedSheet = {
        headers: ["Asset Tag ID", "Cost"],
        rows: [
          {
            rowNumber: 2,
            cells: { "Asset Tag ID": "KE001771", Cost: "229.81" },
          },
          { rowNumber: 3, cells: { "Asset Tag ID": "KE001772", Cost: 12 } },
        ],
      };
      expect(hashRows(fixed)).toBe(
        "b187cc81c223f1127678d6c22d704bd60c7b22226b83e8bca89d8ca1072490a1",
      );
    });

    // What the delimiters are FOR. Without them both sheets feed the hash the
    // identical byte sequence "a1b2", and a swapped file could satisfy C21.
    it("separates key from value, so {a:1,b:2} cannot collide with {ab:12}", () => {
      const split: ParsedSheet = {
        headers: [],
        rows: [{ rowNumber: 1, cells: { a: "1", b: "2" } }],
      };
      const joined: ParsedSheet = {
        headers: [],
        rows: [{ rowNumber: 1, cells: { ab: "12" } }],
      };
      expect(hashRows(split)).not.toBe(hashRows(joined));
    });

    it("is stable across cell ORDER but not across values", async () => {
      const base = cells();
      const reordered = Object.fromEntries(
        Object.entries(base).reverse(),
      ) as Record<string, string | number>;

      expect(hashRows(sheetOf([reordered]))).toBe(hashRows(sheetOf([base])));
      expect(hashRows(sheetOf([{ ...base, Cost: "1.00" }]))).not.toBe(
        hashRows(sheetOf([base])),
      );
    });
  });
});
