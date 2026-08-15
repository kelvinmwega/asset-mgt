// @vitest-environment node
//
// AM-04-C41 — the CLI is EXECUTED, in a real Node process, out of process.
//
// ## Why in-process tests cannot cover this
//
// `scripts/import-assets.test.ts` exercises `parseArgs` and `formatReport`
// under vitest, where `vitest.config.ts` aliases `server-only` to
// `test/server-only-stub.ts`. Every module the CLI depends on —
// `import-run.ts`, `asset-import.ts`, `asset-admin.ts` — begins with
// `import "server-only"`, whose package exports resolve to a THROWING module on
// any condition except `react-server`. Next.js supplies that condition; a plain
// Node process does not.
//
// So the whole suite runs in the one world where the defect is invisible. It
// really happened: 600 tests green, and `pnpm db:import` threw before reading a
// row. `--conditions=react-server` in the package script is the fix, and this
// file is the only thing that can notice it going missing.
//
// Precedent: `scripts/migrate-if-production.test.ts` shells out for exactly
// this reason — enforcement living outside the type-checked, aliased tree
// cannot be covered any other way.
//
// ## Assertions are POSITIVE
//
// Every assertion below names something only the reached code path can
// produce. "It did not throw" would pass for a script that exited early having
// done nothing, which is the failure mode this exists to catch.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legacyExportWorkbook, SAMPLE_ROW } from "../test/xlsx-fixture";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.resolve(import.meta.dirname, "import-assets.ts");

type Run = { status: number; stdout: string; stderr: string };

/**
 * The `--conditions=…` flags THE PACKAGE SCRIPT actually passes.
 *
 * Read out of package.json rather than hardcoded, and that is the whole guard.
 * A test that passed `--conditions=react-server` itself would prove the CLI
 * works when invoked correctly — while `pnpm db:import` could lose the flag and
 * stay green, which is precisely the defect this file exists to catch. Reading
 * the real script means deleting the flag from package.json turns this red.
 */
function packageScriptConditions(): string[] {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  const script = pkg.scripts["db:import"];
  if (!script) throw new Error("package.json has no db:import script");
  return [...script.matchAll(/--conditions=(\S+)/g)].map((match) => match[1]);
}

/**
 * Runs the CLI the way `pnpm db:import` does.
 *
 * `conditions` is overridable so the red-proof is expressible: a test that
 * cannot express the broken configuration cannot prove it catches it.
 */
function runCli(
  args: string[],
  options: {
    conditions?: string[];
    /**
     * Environment overrides. A key set to `undefined` is DELETED rather than
     * set to "" — the difference matters, because the developer's own
     * DIRECT_DATABASE_URL would otherwise leak in from the shell and the
     * "unset" tests would silently stop testing anything. Same reasoning as
     * `runGuard` in migrate-if-production.test.ts.
     */
    env?: Record<string, string | undefined>;
  } = {},
): Run {
  const conditions = options.conditions ?? packageScriptConditions();
  const tsxArgs = [
    "exec",
    "tsx",
    ...conditions.map((condition) => `--conditions=${condition}`),
    SCRIPT,
    ...args,
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIRECT_DATABASE_URL: testDatabaseUrl,
    ...options.env,
  };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
  }
  try {
    const stdout = execFileSync("pnpm", tsxArgs, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as {
      status: number | null;
      stdout: string;
      stderr: string;
    };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe.skipIf(!testDatabaseUrl)(
  "import CLI (executed out of process)",
  () => {
    let workbook: string;
    let row: Record<string, string | number>;
    let db: PrismaClient;

    beforeAll(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "am04-smoke-"));
      workbook = path.join(dir, "export.xlsx");
      // A UNIQUE TAG PER RUN. The fixture's own tag is a fixed literal, and the
      // test database is shared and never truncated — so on the second run the
      // asset already exists and the row is SKIPPED rather than imported, which
      // silently changes what this test is measuring. (Both of this file's
      // order-dependent assertions failed exactly that way before this line.)
      row = {
        ...SAMPLE_ROW,
        "Asset Tag ID": `SMOKE-${randomUUID().slice(0, 10)}`,
      };
      writeFileSync(workbook, Buffer.from(legacyExportWorkbook({ row })));
      db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    });

    afterAll(async () => {
      await db?.$disconnect();
    });

    // THE REGRESSION GUARD. Positive marker: the report banner is printed only
    // after the parser, the mapper and the run have all executed.
    it("starts, parses and reports — the whole chain, in a real Node process", async () => {
      const run = runCli([workbook]);

      expect(run.stderr).not.toContain("server-only");
      expect(run.stdout).toContain("DRY RUN — nothing was written");
      expect(run.stdout).toContain("SIGN-OFF 1");
      expect(run.stdout).toContain("SIGN-OFF 2");
      // The parser really read the sheet rather than failing open on an empty
      // one: the sample row was seen AND mapped.
      expect(run.stdout).toMatch(/source rows\s+1/);
      expect(run.stdout).toMatch(/imported\s+1/);
      expect(run.status).toBe(0);

      // The strongest positive marker available, and deliberately not a string
      // in stdout: an ImportBatch row exists, written by this run, carrying a
      // hash of the file we handed it. Reaching that row means the parser, the
      // mapper, the run and the database all executed.
      //
      // NOT asserted: which categories the census calls "new". That is relative
      // to whatever the shared test database already holds, so an earlier run
      // having created the same category makes it order-dependent — it passed
      // alone and failed straight after a previous smoke run.
      const batchId = /--batch=([a-z0-9]+)/.exec(run.stdout)?.[1];
      expect(batchId).toBeDefined();
      const batch = await db.importBatch.findUniqueOrThrow({
        where: { id: batchId },
      });
      expect(batch.dryRun).toBe(true);
      expect(batch.sourceSha256).toHaveLength(64);
      expect(batch.rowsOk).toBe(1);
    });

    // THE RED-PROOF, expressed rather than described. Drop the condition the
    // package script passes and the command dies on `server-only` — which is
    // exactly what happened in development while every other test was green.
    it("dies on server-only without the react-server condition", () => {
      const run = runCli([workbook], { conditions: [] });

      expect(run.status).not.toBe(0);
      expect(`${run.stderr}${run.stdout}`).toContain(
        "This module cannot be imported from a Client Component",
      );
      // …and it never reached the work.
      expect(run.stdout).not.toContain("DRY RUN");
    });

    it("refuses to run with no file, rather than defaulting to one", () => {
      const run = runCli([]);

      expect(run.status).not.toBe(0);
      expect(`${run.stderr}${run.stdout}`).toContain("Usage:");
    });

    // Copilot review, PR #36. This used to print a warning and carry on, which
    // is incoherent with its own reasoning: if a pooled connection makes the run
    // lock unreliable, a warning is not a mitigation — the operator has already
    // typed the command and is watching rows scroll past. It refuses now.
    it("REFUSES to commit without an unpooled connection", () => {
      const run = runCli([workbook, "--commit", "--batch=whatever"], {
        // Pooled-looking: DIRECT_DATABASE_URL genuinely absent (deleted, not
        // blanked), DATABASE_URL present so the run has somewhere to connect.
        env: { DIRECT_DATABASE_URL: undefined, DATABASE_URL: testDatabaseUrl },
      });

      expect(run.status).not.toBe(0);
      expect(`${run.stderr}${run.stdout}`).toContain(
        "requires DIRECT_DATABASE_URL",
      );
      // It stopped BEFORE looking the batch up — nothing was read or written.
      expect(`${run.stderr}${run.stdout}`).not.toContain("No import batch");
    });

    // A dry run is deliberately NOT subject to that rule: it takes the lock too,
    // but nothing it writes survives, so a lost lock cannot leave duplicates.
    it("still allows a DRY RUN on a pooled connection", () => {
      const run = runCli([workbook], {
        env: { DIRECT_DATABASE_URL: undefined, DATABASE_URL: testDatabaseUrl },
      });

      expect(run.status).toBe(0);
      expect(run.stdout).toContain("DRY RUN");
    });

    // AM-04-C21 end to end, through the real entry point: a dry run's batch id
    // binds to the file it reviewed, and a different file is refused.
    it("binds a batch to its file and refuses a different one", () => {
      const dry = runCli([workbook]);
      const batchId = /--batch=([a-z0-9]+)/.exec(dry.stdout)?.[1];
      expect(batchId).toBeDefined();

      const changed = path.join(path.dirname(workbook), "changed.xlsx");
      writeFileSync(
        changed,
        Buffer.from(legacyExportWorkbook({ row: { ...row, Cost: "999.99" } })),
      );

      const run = runCli([changed, "--commit", `--batch=${batchId}`]);

      expect(run.status).not.toBe(0);
      expect(`${run.stderr}${run.stdout}`).toContain("The file has changed");
    });
  },
  120_000,
);
