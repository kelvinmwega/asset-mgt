// @vitest-environment node
//
// AM-04 DESIGN §10, real-DB items. Mocks cannot guard any of these seams: the
// exact event count an import writes, the back-dated assignment, the nullable
// unique index that now permits many email-less people, or the advisory lock
// that keeps two runs from each creating their own copy of one person.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AssetEventType, AssetStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { singleConnectionUrl } from "../../test/session-lock-client";
import {
  createHolderResolver,
  IMPORT_ADVISORY_LOCK_KEY,
  importAssetWithEvent,
  withImportLock,
} from "@/lib/asset-import";
import { foldName } from "@/lib/import-map";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)("asset import (real DB)", () => {
  let db: PrismaClient;
  let categoryId: string;

  beforeAll(async () => {
    execSync("pnpm exec prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
    db = new PrismaClient({
      datasourceUrl: singleConnectionUrl(testDatabaseUrl),
    });
    const category = await db.category.create({
      data: { name: `Imported ${randomUUID()}` },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const uniqueTag = () => `IMP-${randomUUID().slice(0, 12)}`;
  const uniqueName = (stem: string) =>
    `${stem} ${randomUUID().slice(0, 8).toUpperCase()}`;

  function assetInput(overrides: Record<string, unknown> = {}) {
    return {
      tag: uniqueTag(),
      categoryId,
      siteId: null,
      status: AssetStatus.IN_STOCK,
      // The imported shape: no make, no model, identity in description.
      description: "HP USB-C G5 Essential Docking Station",
      make: null,
      model: null,
      serial: null,
      supplier: "Read technologies",
      purchasedAt: new Date("2023-09-08T00:00:00.000Z"),
      purchasePrice: "229.81",
      poNumber: "PO220202300331",
      costCentre: "CC3200",
      department: "Mitigate",
      location: "IITA Nairobi ICIPE Office",
      holder: null,
      ...overrides,
    } as Parameters<typeof importAssetWithEvent>[1];
  }

  const eventsFor = (assetId: string) =>
    db.assetEvent.findMany({
      where: { assetId },
      orderBy: [{ at: "asc" }, { id: "asc" }],
    });

  describe("importAssetWithEvent", () => {
    it("writes the asset and exactly one IMPORTED event", async () => {
      const { assetId } = await db.$transaction((tx) =>
        importAssetWithEvent(tx, assetInput()),
      );

      const events = await eventsFor(assetId);
      // EXACT COUNT, not a floor (advisor condition C19). A `>= 1` assertion
      // would pass for the create-then-transition shape this whole module
      // exists to avoid.
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(AssetEventType.IMPORTED);
      expect(events[0].fromStatus).toBeNull();
      expect(events[0].toStatus).toBe(AssetStatus.IN_STOCK);
      // System action, per the seed-script convention — never an impersonated
      // admin, which the audit trail could not later tell from real activity.
      expect(events[0].actorId).toBeNull();
      // No personal data reaches this table, ever.
      expect(events[0].notes).toBeNull();
    });

    it("stores the columns the export actually populates", async () => {
      const { assetId } = await db.$transaction((tx) =>
        importAssetWithEvent(tx, assetInput()),
      );
      const asset = await db.asset.findUniqueOrThrow({
        where: { id: assetId },
      });

      expect(asset.description).toBe("HP USB-C G5 Essential Docking Station");
      expect(asset.make).toBeNull();
      expect(asset.model).toBeNull();
      expect(asset.poNumber).toBe("PO220202300331");
      expect(asset.costCentre).toBe("CC3200");
      expect(asset.department).toBe("Mitigate");
      expect(asset.location).toBe("IITA Nairobi ICIPE Office");
      // Decimal(12,2), routed as a string so 229.81 stays 229.81 rather than
      // becoming 229.80999999999997 through a JS float.
      expect(asset.purchasePrice?.toString()).toBe("229.81");
    });

    // THE CARRY-FORWARD FROM AM-02 AND AM-03, head-on. A legacy ASSIGNED row
    // cannot be created by createAssetWithEvent at all, and the workarounds —
    // create-then-transition, or calling assignAsset — each fabricate an event
    // for something that never happened.
    it("imports a legacy ASSIGNED asset in ONE event, back-dated", async () => {
      const person = await db.person.create({
        data: { name: uniqueName("Jane Holder"), email: null },
      });
      const checkedOutAt = new Date("2023-10-01T09:00:00.000Z");

      const { assetId, assignmentId } = await db.$transaction((tx) =>
        importAssetWithEvent(
          tx,
          assetInput({
            status: AssetStatus.ASSIGNED,
            holder: { personId: person.id, checkedOutAt },
          }),
        ),
      );

      const events = await eventsFor(assetId);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(AssetEventType.IMPORTED);
      // NOT an ASSIGNED event, and not an IMPORTED followed by one. Status
      // questions are answered from toStatus, never from the event type.
      expect(events[0].toStatus).toBe(AssetStatus.ASSIGNED);
      expect(events[0].assignmentId).toBe(assignmentId);

      const assignment = await db.assignment.findUniqueOrThrow({
        where: { id: assignmentId! },
      });
      // The SOURCE date, not today. This is the whole reason
      // createOpenAssignmentTx has a checkedOutAt parameter — a handover from
      // two years ago must not be recorded as happening during the cutover.
      expect(assignment.checkedOutAt.toISOString()).toBe(
        checkedOutAt.toISOString(),
      );
      expect(assignment.returnedAt).toBeNull();
      expect(assignment.personId).toBe(person.id);
    });

    it("refuses an ASSIGNED asset with no holder", async () => {
      await expect(
        db.$transaction((tx) =>
          importAssetWithEvent(
            tx,
            assetInput({ status: AssetStatus.ASSIGNED, holder: null }),
          ),
        ),
      ).rejects.toThrow(/ASSIGNED asset with no holder/);
    });

    it("refuses a holder on an asset that is not ASSIGNED", async () => {
      const person = await db.person.create({
        data: { name: uniqueName("Wrong Status"), email: null },
      });
      await expect(
        db.$transaction((tx) =>
          importAssetWithEvent(
            tx,
            assetInput({
              status: AssetStatus.IN_STOCK,
              holder: { personId: person.id, checkedOutAt: new Date() },
            }),
          ),
        ),
      ).rejects.toThrow(/Refusing to open an assignment/);
    });

    // The am02 CHECK constraint, inherited. A tagless IN_STOCK row is exactly
    // the state the register exists to prevent, and the constraint — not the
    // application guard — is the enforcement.
    it("cannot import a tracked asset with a blank tag", async () => {
      await expect(
        db.$transaction((tx) =>
          importAssetWithEvent(tx, assetInput({ tag: "   " })),
        ),
      ).rejects.toThrow();
    });

    it("rolls the event back with the asset when the transaction fails", async () => {
      const tag = uniqueTag();
      await expect(
        db.$transaction(async (tx) => {
          await importAssetWithEvent(tx, assetInput({ tag }));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      expect(await db.asset.findUnique({ where: { tag } })).toBeNull();
    });
  });

  describe("holder resolution", () => {
    it("links an existing person by exact name", async () => {
      const name = uniqueName("Exact Match");
      const person = await db.person.create({ data: { name, email: null } });

      const resolver = await createHolderResolver(db, foldName);
      const result = await db.$transaction((tx) => resolver.resolve(tx, name));

      expect(result).toEqual({ kind: "matched", personId: person.id });
    });

    it("matches case-insensitively and across collapsed whitespace", async () => {
      // The bug this resolver is shaped to avoid: `mode: "insensitive"` folds
      // CASE ONLY, so a person stored with a double space would not match the
      // folded name and the import would create a SECOND copy of them.
      const stem = randomUUID().slice(0, 8).toUpperCase();
      const person = await db.person.create({
        data: { name: `Jane  Holder ${stem}`, email: null },
      });

      const resolver = await createHolderResolver(db, foldName);
      const result = await db.$transaction((tx) =>
        resolver.resolve(tx, `  jane holder ${stem.toLowerCase()} `),
      );

      expect(result).toEqual({ kind: "matched", personId: person.id });
    });

    it("creates a stub with no email when there is no match", async () => {
      const name = uniqueName("New Starter");
      const resolver = await createHolderResolver(db, foldName);
      const result = await db.$transaction((tx) => resolver.resolve(tx, name));

      expect(result.kind).toBe("created");
      const person = await db.person.findUniqueOrThrow({
        where: { id: (result as { personId: string }).personId },
      });
      // Never a synthesized address (C2). The name is stored AS TYPED, not
      // folded — a register that renamed people to their match key would be
      // worse than one that matched strictly.
      expect(person.email).toBeNull();
      expect(person.employeeRef).toBeNull();
      expect(person.name).toBe(name);
    });

    it("REFUSES an ambiguous name rather than guessing", async () => {
      // Two real humans who share a name. Guessing attributes one person's
      // laptop to the other, and the result is indistinguishable from a correct
      // import afterwards.
      const name = uniqueName("Ambiguous Twin");
      await db.person.create({ data: { name, email: null } });
      await db.person.create({ data: { name, email: null } });

      const resolver = await createHolderResolver(db, foldName);
      const result = await db.$transaction((tx) => resolver.resolve(tx, name));

      expect(result).toEqual({ kind: "ambiguous" });
    });

    // Without the cache write, every asset held by the same person would create
    // another copy of them — and in a register of ~400 assets with far fewer
    // people, that is most rows.
    it("links a second row to the stub the first row created", async () => {
      const name = uniqueName("Repeat Holder");
      const resolver = await createHolderResolver(db, foldName);

      const first = await db.$transaction((tx) => resolver.resolve(tx, name));
      const second = await db.$transaction((tx) => resolver.resolve(tx, name));

      expect(first.kind).toBe("created");
      expect(second.kind).toBe("matched");
      expect((second as { personId: string }).personId).toBe(
        (first as { personId: string }).personId,
      );
      expect(await db.person.count({ where: { name } })).toBe(1);
    });

    // The nullable unique index, proven at the DB layer. Postgres permits many
    // NULLs but exactly one '' — which is why a blank email must normalise to
    // NULL, the same trap as Asset.tag.
    it("permits many people with no email at all", async () => {
      const stem = randomUUID().slice(0, 8);
      await db.person.create({ data: { name: `A ${stem}`, email: null } });
      await db.person.create({ data: { name: `B ${stem}`, email: null } });

      expect(
        await db.person.count({ where: { name: { endsWith: stem } } }),
      ).toBe(2);
    });
  });

  describe("run lock", () => {
    /**
     * The lock is RELEASED, not merely taken (AM-10 review).
     *
     * `pg_advisory_lock` is owned by the backend that took it, and Prisma keeps
     * a client-side pool **even against an unpooled URL** — so the unlock can be
     * delivered to a different backend. It then returns `false` silently and the
     * lock survives. `withImportLock`'s `try/finally` is correct and cannot help:
     * the statement runs, it just runs in the wrong session.
     *
     * The consequence is a **deadlock, not a lost mutex** — the lock is
     * over-held, so the next acquire in the same process blocks forever. That is
     * why it surfaced as a 20s test timeout plus a 10s `$disconnect()` hook
     * timeout, intermittently, on CI only, and never once locally.
     *
     * This test exists because the fix (`singleConnectionUrl`) had no guard, and
     * a defect that is invisible where it is caused is protected by nothing but
     * memory — the same argument that put a test on `test/time-zone.ts`.
     *
     * `pg_locks` is CLUSTER-wide, so it sees a leaked lock on whichever backend
     * holds it, whatever connection asks. A `pg_backend_pid()` equality check
     * would pass by luck whenever the pool happened to hand back the same
     * connection. `IMPORT_ADVISORY_LOCK_KEY` is below 2^32, so the single-argument
     * `bigint` form stores it in `objid` with `objsubid = 1`.
     *
     * Red-proven by removing `singleConnectionUrl` from this file's client.
     */
    it("leaves no advisory lock behind", async () => {
      await withImportLock(db, async () => {
        // Churn the pool inside the locked section. Without the single-connection
        // pin these open further backends, and the unlock lands on one of them.
        await Promise.all(
          Array.from({ length: 40 }, () => db.$queryRaw`SELECT 1`),
        );
      });

      const [{ held }] = await db.$queryRaw<{ held: number }[]>`
        SELECT count(*)::int AS held FROM pg_locks
        WHERE locktype = 'advisory'
          AND objid = ${IMPORT_ADVISORY_LOCK_KEY}
          AND objsubid = 1`;

      expect(held).toBe(0);
    });

    it("serialises two runs that would otherwise both create one person", async () => {
      // The hazard that REPLACED the deadlock reason for AM-04-CF-A: email is
      // nullable now, so @unique no longer dedupes stub people and two
      // concurrent runs would each find no match and each create a "Jane".
      const name = uniqueName("Concurrent Holder");
      const other = new PrismaClient({
        datasourceUrl: singleConnectionUrl(testDatabaseUrl),
      });
      try {
        const order: string[] = [];
        const runOne = withImportLock(db, async () => {
          order.push("one:start");
          const resolver = await createHolderResolver(db, foldName);
          await db.$transaction((tx) => resolver.resolve(tx, name));
          await new Promise((resolve) => setTimeout(resolve, 150));
          order.push("one:end");
        });
        // Starts while the first holds the lock; must not interleave.
        const runTwo = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return withImportLock(other, async () => {
            order.push("two:start");
            const resolver = await createHolderResolver(other, foldName);
            await other.$transaction((tx) => resolver.resolve(tx, name));
            order.push("two:end");
          });
        })();

        await Promise.all([runOne, runTwo]);

        expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
        // One human, one Person row — the property the lock is actually for.
        expect(await db.person.count({ where: { name } })).toBe(1);
      } finally {
        await other.$disconnect();
      }
    });

    it("releases the lock when the run throws", async () => {
      await expect(
        withImportLock(db, async () => {
          throw new Error("run failed");
        }),
      ).rejects.toThrow("run failed");

      // Re-acquirable, so a failed cutover run does not wedge the next attempt
      // behind a lock nobody can see.
      await expect(withImportLock(db, async () => "ok")).resolves.toBe("ok");
    });
  });
});
