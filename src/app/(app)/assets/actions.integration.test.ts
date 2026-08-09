// @vitest-environment node
//
// PLAN.md §Verification: the write-role matrix on every asset action —
// ADMIN_IT/PROCUREMENT allowed, FINANCE/STAFF_RO denied — plus the boundary
// behaviour the friendly error messages promise. Session identity is mocked;
// the role read and every write are REAL DB. If any action loses its leading
// `await requireRole(...)`, the denial tests go red.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  AssetEventType,
  AssetStatus,
  PrismaClient,
  Role,
} from "@prisma/client";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
// Cache revalidation is Next.js request plumbing, not the seam under test.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { pinTimeZone } from "../../../../test/time-zone";
import { auth } from "@/auth";
import { AuthorizationError } from "@/lib/authz";
import {
  assignAssetToPerson,
  createAsset,
  receiveAndTagAsset,
  retireAsset,
  returnAssetFromPerson,
  returnFromRepair,
  sendToRepair,
  updateAsset,
} from "@/app/(app)/assets/actions";
import {
  ALREADY_ASSIGNED_MESSAGE,
  CONDITION_NOTES_REQUIRED_MESSAGE,
  DUPLICATE_TAG_MESSAGE,
  ILLEGAL_TRANSITION_MESSAGE,
  PERSON_NOT_ASSIGNABLE_MESSAGE,
} from "@/lib/asset-errors";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mockAuth = auth as unknown as Mock;

describe.skipIf(!testDatabaseUrl)("asset actions (real DB)", () => {
  let db: PrismaClient;
  let categoryId: string;

  beforeAll(async () => {
    execSync("pnpm exec prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AUTH_SECRET = "test-secret";
    process.env.AUTH_RESEND_KEY = "test-key";
    process.env.AUTH_EMAIL_FROM = "test@example.com";
    db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    const category = await db.category.create({
      data: { name: `Actions ${randomUUID()}` },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function signInAs(role: Role) {
    const user = await db.user.create({
      data: {
        email: `assetactions-${randomUUID()}@example.com`,
        name: "Asset Actions Test",
        role,
      },
    });
    mockAuth.mockResolvedValue({ user: { id: user.id } });
    return user;
  }

  function formData(entries: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [key, value] of Object.entries(entries)) {
      fd.set(key, value);
    }
    return fd;
  }

  const uniqueTag = () => `ACT-${randomUUID().slice(0, 12)}`;

  function createFields(overrides: Record<string, string> = {}) {
    return {
      tag: "",
      categoryId,
      make: "HP",
      model: "EliteBook 840",
      serial: "",
      purchasedAt: "",
      purchasePrice: "",
      supplier: "",
      warrantyUntil: "",
      condition: "",
      siteId: "",
      status: AssetStatus.ON_ORDER,
      ...overrides,
    };
  }

  /**
   * Drives createAsset and returns the id of the asset it created.
   *
   * A successful create redirects to the new asset's detail page, so it throws
   * NEXT_REDIRECT rather than returning a state. Reading the id back out of the
   * redirect target is also the assertion that the redirect goes where the
   * operator needs it to (nit N4) — landing anywhere else, or not redirecting
   * at all, fails here.
   */
  async function createAssetExpectingRedirect(
    fields: Record<string, string>,
  ): Promise<string> {
    // The no-redirect case is captured, not thrown from inside the try — a
    // throw there lands in this function's own catch, which swallows the
    // diagnostic and reports "expected undefined to match /^NEXT_REDIRECT/"
    // instead of the message written to explain the failure.
    let returnedState: unknown;
    let thrown: unknown;
    try {
      returnedState = await createAsset(null, formData(fields));
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) {
      throw new Error(
        `Expected createAsset to redirect, got ${JSON.stringify(returnedState)}`,
      );
    }
    {
      const error = thrown;
      const digest = (error as { digest?: string }).digest;
      expect(digest).toMatch(/^NEXT_REDIRECT/);
      const target = digest?.match(/\/assets\/([^;]+)/);
      expect(target).not.toBeNull();
      return target![1];
    }
  }

  /** An ON_ORDER asset owned by the currently signed-in actor's session. */
  async function anOrderedAsset() {
    const id = await createAssetExpectingRedirect(createFields());
    return db.asset.findUniqueOrThrow({ where: { id } });
  }

  const mutatingActions = [
    ["createAsset", createAsset],
    ["updateAsset", updateAsset],
    ["receiveAndTagAsset", receiveAndTagAsset],
    ["sendToRepair", sendToRepair],
    ["returnFromRepair", returnFromRepair],
    ["retireAsset", retireAsset],
    ["assignAssetToPerson", assignAssetToPerson],
    ["returnAssetFromPerson", returnAssetFromPerson],
  ] as const;

  for (const [name, action] of mutatingActions) {
    it(`${name} denies FINANCE and STAFF_RO server-side`, async () => {
      for (const role of [Role.FINANCE, Role.STAFF_RO]) {
        await signInAs(role);
        await expect(action(null, formData({}))).rejects.toThrow(
          AuthorizationError,
        );
      }
    });
  }

  it("lets both write roles create an asset with its CREATED event", async () => {
    for (const role of [Role.ADMIN_IT, Role.PROCUREMENT]) {
      const actor = await signInAs(role);
      const tag = uniqueTag();

      const id = await createAssetExpectingRedirect(
        createFields({ tag, status: AssetStatus.IN_STOCK }),
      );

      const asset = await db.asset.findUniqueOrThrow({
        where: { id },
        include: { events: true },
      });
      expect(asset.tag).toBe(tag);
      expect(asset.status).toBe(AssetStatus.IN_STOCK);
      expect(asset.events).toHaveLength(1);
      expect(asset.events[0]).toMatchObject({
        type: AssetEventType.CREATED,
        actorId: actor.id,
        toStatus: AssetStatus.IN_STOCK,
      });
    }
  });

  /**
   * G2 (DESIGN §7). `<input type="date">` submits a bare `YYYY-MM-DD`, and
   * `optionalDate` pins it with an explicit `Z`. Without that character
   * `new Date("2026-03-15T00:00:00")` is parsed in the SERVER's zone, and every
   * purchase and warranty date lands a day early for every zone east of UTC —
   * which is all of them here, since the deployment zone is UTC+3.
   *
   * **The process zone is pinned because CI has no `TZ` and runs in UTC**,
   * where the pinned and unpinned forms parse identically and this test would
   * pass against the bug forever. It only ever failed on a developer's laptop
   * before — the same shape as the hand-edited-migration trap in LEARNINGS.
   *
   * Red-proven by deleting the `Z` from the template literal in
   * `optionalDate`: the stored value becomes 2026-03-14T21:00:00.000Z.
   *
   * This matters more since AM-10 than before it. Everything else on these
   * pages now moves with the viewer, so a date input silently acquiring a
   * timezone is the one change that would corrupt data rather than merely
   * display it oddly.
   */
  it("accepts a zero purchase price and pins dates to UTC midnight", async () => {
    await signInAs(Role.PROCUREMENT);
    const tag = uniqueTag();
    const restoreTz = pinTimeZone("Africa/Nairobi");

    try {
      await createAssetExpectingRedirect(
        createFields({
          tag,
          status: AssetStatus.IN_STOCK,
          // 0 is a real price for donated kit — .positive() would reject it.
          purchasePrice: "0",
          purchasedAt: "2026-03-15",
        }),
      );
    } finally {
      restoreTz();
    }

    const asset = await db.asset.findUniqueOrThrow({ where: { tag } });
    expect(asset.purchasePrice?.toString()).toBe("0");
    expect(asset.purchasedAt?.toISOString()).toBe("2026-03-15T00:00:00.000Z");
  });

  it("reports a duplicate tag as a form error, not a crash", async () => {
    await signInAs(Role.ADMIN_IT);
    const tag = uniqueTag();
    const fields = createFields({ tag, status: AssetStatus.IN_STOCK });

    await createAssetExpectingRedirect(fields);
    // The duplicate returns a form state rather than redirecting — only a
    // successful create navigates away.
    await expect(createAsset(null, formData(fields))).resolves.toMatchObject({
      ok: false,
      message: "An asset with that tag already exists.",
    });
    await expect(db.asset.count({ where: { tag } })).resolves.toBe(1);
  });

  it("refuses to receive an asset with no tag, then accepts one with a tag", async () => {
    await signInAs(Role.PROCUREMENT);
    const asset = await anOrderedAsset();

    await expect(
      receiveAndTagAsset(null, formData({ assetId: asset.id, tag: "" })),
    ).resolves.toMatchObject({
      ok: false,
      message: "A tag is required before this asset can move into stock.",
    });
    await expect(
      db.asset.findUniqueOrThrow({ where: { id: asset.id } }),
    ).resolves.toMatchObject({ status: AssetStatus.ON_ORDER, tag: null });

    const tag = uniqueTag();
    await expect(
      receiveAndTagAsset(
        null,
        formData({ assetId: asset.id, tag, notes: "Delivered" }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      db.asset.findUniqueOrThrow({ where: { id: asset.id } }),
    ).resolves.toMatchObject({ status: AssetStatus.IN_STOCK, tag });
  });

  it("blames the tag only when the tag is what failed", async () => {
    await signInAs(Role.PROCUREMENT);
    const asset = await anOrderedAsset();

    // Missing assetId is not a tagging problem: reporting it as one sends the
    // operator hunting for a tag that was never the issue (nit N5).
    await expect(
      receiveAndTagAsset(null, formData({ assetId: "", tag: uniqueTag() })),
    ).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("Check the form"),
    });

    // A blank tag still earns the tag message.
    await expect(
      receiveAndTagAsset(null, formData({ assetId: asset.id, tag: "   " })),
    ).resolves.toMatchObject({
      ok: false,
      message: "A tag is required before this asset can move into stock.",
    });
  });

  it("reports an illegal transition as a form error, not a crash", async () => {
    await signInAs(Role.ADMIN_IT);
    const asset = await anOrderedAsset();

    // ON_ORDER has no repair edge — the asset has not been delivered yet.
    await expect(
      sendToRepair(null, formData({ assetId: asset.id })),
    ).resolves.toMatchObject({
      ok: false,
      message:
        "That status change isn't allowed from this asset's current status.",
    });
    await expect(
      db.assetEvent.count({
        where: { assetId: asset.id, type: AssetEventType.STATUS_CHANGED },
      }),
    ).resolves.toBe(0);
  });

  it("walks receive -> repair -> return -> retire through the actions", async () => {
    const actor = await signInAs(Role.ADMIN_IT);
    const asset = await anOrderedAsset();
    const tag = uniqueTag();

    await expect(
      receiveAndTagAsset(null, formData({ assetId: asset.id, tag })),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendToRepair(
        null,
        formData({
          assetId: asset.id,
          condition: "DEFECTIVE",
          notes: "Battery swelling",
        }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      returnFromRepair(
        null,
        formData({ assetId: asset.id, condition: "GOOD" }),
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      retireAsset(null, formData({ assetId: asset.id, notes: "End of life" })),
    ).resolves.toMatchObject({ ok: true });

    // RETIRED is the delete: the row and its whole history survive.
    const after = await db.asset.findUniqueOrThrow({
      where: { id: asset.id },
      include: { events: { orderBy: [{ at: "asc" }, { id: "asc" }] } },
    });
    expect(after.status).toBe(AssetStatus.RETIRED);
    expect(after.events.map((event) => event.toStatus)).toEqual([
      AssetStatus.ON_ORDER,
      AssetStatus.IN_STOCK,
      AssetStatus.IN_REPAIR,
      AssetStatus.IN_STOCK,
      AssetStatus.RETIRED,
    ]);
    expect(after.events.every((event) => event.actorId === actor.id)).toBe(
      true,
    );
  });

  it("edits fields without touching status and audits the change", async () => {
    await signInAs(Role.PROCUREMENT);
    const asset = await anOrderedAsset();

    const result = await updateAsset(
      null,
      formData({
        ...createFields({ make: "Lenovo", supplier: "Acme Ltd" }),
        assetId: asset.id,
      }),
    );

    expect(result).toMatchObject({ ok: true });
    const after = await db.asset.findUniqueOrThrow({
      where: { id: asset.id },
      include: { events: { where: { type: AssetEventType.UPDATED } } },
    });
    expect(after).toMatchObject({
      make: "Lenovo",
      supplier: "Acme Ltd",
      status: AssetStatus.ON_ORDER,
    });
    expect(after.events).toHaveLength(1);
    expect(after.events[0]?.notes).toContain("make");
  });

  it("rejects an incomplete create with a form error and writes nothing", async () => {
    await signInAs(Role.ADMIN_IT);
    // Scoped to this file's own category, never the whole table: the test
    // database is shared with the reference-data suite running concurrently,
    // so a global count would flake on their rows. Both rejected creates below
    // post this categoryId, so a row that wrongly landed would still be caught.
    const scope = { categoryId };
    const before = await db.asset.count({ where: scope });
    // The scope must actually select this file's rows — a filter that matched
    // nothing would make the count assertion below pass unconditionally
    // (LEARNINGS §Testing, vacuous tests). Earlier tests here have created
    // assets under this category.
    expect(before).toBeGreaterThan(0);

    await expect(
      createAsset(null, formData(createFields({ make: "  " }))),
    ).resolves.toMatchObject({ ok: false });
    // A negative price is rejected too; 0 is not (see the zero-price test).
    await expect(
      createAsset(null, formData(createFields({ purchasePrice: "-1" }))),
    ).resolves.toMatchObject({ ok: false });

    await expect(db.asset.count({ where: scope })).resolves.toBe(before);
  });

  describe("assignment", () => {
    /** An IN_STOCK, tagged asset ready to be handed out. */
    async function aStockedAsset() {
      const id = await createAssetExpectingRedirect(
        createFields({ tag: uniqueTag(), status: AssetStatus.IN_STOCK }),
      );
      return db.asset.findUniqueOrThrow({ where: { id } });
    }

    async function aPerson(name = "Assignee") {
      return db.person.create({
        data: {
          name,
          email: `assignee-${randomUUID()}@example.com`,
          employeeRef: `REF-${randomUUID().slice(0, 8)}`,
        },
      });
    }

    it("lets both write roles assign and take back an asset", async () => {
      for (const role of [Role.ADMIN_IT, Role.PROCUREMENT]) {
        const actor = await signInAs(role);
        const asset = await aStockedAsset();
        const holder = await aPerson();

        await expect(
          assignAssetToPerson(
            null,
            formData({ assetId: asset.id, personId: holder.id, notes: "" }),
          ),
        ).resolves.toMatchObject({ ok: true });

        const assigned = await db.asset.findUniqueOrThrow({
          where: { id: asset.id },
        });
        expect(assigned.status).toBe(AssetStatus.ASSIGNED);

        await expect(
          returnAssetFromPerson(
            null,
            formData({
              assetId: asset.id,
              toStatus: AssetStatus.IN_STOCK,
              condition: "GOOD",
              conditionNotes: "",
            }),
          ),
        ).resolves.toMatchObject({ ok: true });

        const returned = await db.asset.findUniqueOrThrow({
          where: { id: asset.id },
          include: { events: { orderBy: [{ at: "asc" }, { id: "asc" }] } },
        });
        expect(returned.status).toBe(AssetStatus.IN_STOCK);
        expect(returned.events.map((event) => event.type)).toEqual([
          AssetEventType.CREATED,
          AssetEventType.ASSIGNED,
          AssetEventType.RETURNED,
        ]);
        expect(returned.events[1]?.actorId).toBe(actor.id);
      }
    });

    it("requires a condition note for a repair-bound return", async () => {
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();
      const holder = await aPerson();
      await assignAssetToPerson(
        null,
        formData({ assetId: asset.id, personId: holder.id, notes: "" }),
      );

      await expect(
        returnAssetFromPerson(
          null,
          formData({
            assetId: asset.id,
            toStatus: AssetStatus.IN_REPAIR,
            condition: "DEFECTIVE",
            conditionNotes: "   ",
          }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: CONDITION_NOTES_REQUIRED_MESSAGE,
      });

      // Rejected at the boundary: the asset is untouched and still held.
      const untouched = await db.asset.findUniqueOrThrow({
        where: { id: asset.id },
      });
      expect(untouched.status).toBe(AssetStatus.ASSIGNED);

      // …and the same return succeeds once the note is supplied.
      await expect(
        returnAssetFromPerson(
          null,
          formData({
            assetId: asset.id,
            toStatus: AssetStatus.IN_REPAIR,
            condition: "DEFECTIVE",
            conditionNotes: "Won't hold charge",
          }),
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it("accepts a routine GOOD return with no note", async () => {
      // The other half of the rule: demanding prose on every return trains
      // operators to type "ok". Without this test the guard could tighten to
      // "always required" and nothing would fail.
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();
      const holder = await aPerson();
      await assignAssetToPerson(
        null,
        formData({ assetId: asset.id, personId: holder.id, notes: "" }),
      );

      await expect(
        returnAssetFromPerson(
          null,
          formData({
            assetId: asset.id,
            toStatus: AssetStatus.IN_STOCK,
            condition: "GOOD",
            conditionNotes: "",
          }),
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it("closes the assignment when a stale sendToRepair lands on an assigned asset", async () => {
      // The reachable stale-form path: an operator holds a detail page that
      // still says IN_STOCK, someone else assigns the asset, and the operator
      // clicks "Send to repair". The UI never offers that move on an ASSIGNED
      // asset, so this is the only way in — and it must still leave a coherent
      // register: assignment closed, ONE event, and the operator's note carried
      // onto the closing record rather than dropped.
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();
      const holder = await aPerson("Stale Form Holder");
      await assignAssetToPerson(
        null,
        formData({ assetId: asset.id, personId: holder.id, notes: "" }),
      );

      await expect(
        sendToRepair(
          null,
          formData({
            assetId: asset.id,
            condition: "DEFECTIVE",
            notes: "Screen cracked in transit",
          }),
        ),
      ).resolves.toMatchObject({ ok: true });

      const after = await db.asset.findUniqueOrThrow({
        where: { id: asset.id },
        include: {
          events: { orderBy: [{ at: "asc" }, { id: "asc" }] },
          assignments: true,
        },
      });
      expect(after.status).toBe(AssetStatus.IN_REPAIR);
      expect(after.assignments).toHaveLength(1);
      expect(after.assignments[0]?.returnedAt).not.toBeNull();
      expect(after.assignments[0]?.conditionNotes).toBe(
        "Screen cracked in transit",
      );
      // One event, typed RETURNED because it closed an assignment — not a
      // STATUS_CHANGED, and not two rows.
      expect(after.events.map((event) => event.type)).toEqual([
        AssetEventType.CREATED,
        AssetEventType.ASSIGNED,
        AssetEventType.RETURNED,
      ]);
      expect(after.events[2]).toMatchObject({
        fromStatus: AssetStatus.ASSIGNED,
        toStatus: AssetStatus.IN_REPAIR,
      });
    });

    it("refuses a stale sendToRepair that would close an assignment with no note", async () => {
      // Copilot review. The stale-form path closes a real assignment, and
      // `sendToRepair`'s schema cannot require a note — from IN_STOCK there is
      // no assignment to describe. So the same repair-bound closure carried a
      // note through returnAssetFromPerson and a silent null through here.
      //
      // The rule now lives in the write layer against the LOCKED status, which
      // is the only place that knows an assignment is actually being closed.
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();
      const holder = await aPerson("Noteless Repair");
      await assignAssetToPerson(
        null,
        formData({ assetId: asset.id, personId: holder.id, notes: "" }),
      );

      await expect(
        sendToRepair(
          null,
          formData({ assetId: asset.id, condition: "DEFECTIVE", notes: "  " }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: CONDITION_NOTES_REQUIRED_MESSAGE,
      });

      // Rejected inside the transaction: the asset is untouched and still held.
      const untouched = await db.asset.findUniqueOrThrow({
        where: { id: asset.id },
        include: { assignments: true },
      });
      expect(untouched.status).toBe(AssetStatus.ASSIGNED);
      expect(untouched.assignments[0]?.returnedAt).toBeNull();

      // The same move succeeds once the note is supplied.
      await expect(
        sendToRepair(
          null,
          formData({
            assetId: asset.id,
            condition: "DEFECTIVE",
            notes: "Keyboard flooded",
          }),
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it("still sends an unassigned asset to repair without a note", async () => {
      // The other half: the note is required only where an assignment is being
      // closed. Without this, the guard could tighten to "always required" and
      // break the ordinary IN_STOCK -> IN_REPAIR path with nothing failing.
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();

      await expect(
        sendToRepair(
          null,
          formData({ assetId: asset.id, condition: "DEFECTIVE", notes: "" }),
        ),
      ).resolves.toMatchObject({ ok: true });
    });

    it("refuses to assign to a deactivated person with a specific message", async () => {
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();
      const leaver = await aPerson("Leaver");
      await db.user.create({
        data: {
          email: `leaver-action-${randomUUID()}@example.com`,
          name: "Leaver",
          role: Role.STAFF_RO,
          personId: leaver.id,
          deactivatedAt: new Date(),
        },
      });

      await expect(
        assignAssetToPerson(
          null,
          formData({ assetId: asset.id, personId: leaver.id, notes: "" }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: PERSON_NOT_ASSIGNABLE_MESSAGE,
      });
    });

    it("reports a duplicate tag and an assignment conflict distinctly", async () => {
      // P2002 stopped being synonymous with "duplicate tag" when AM-03 added
      // Assignment_one_open_per_asset. Both messages are pinned here against
      // REAL Postgres errors, because the discriminator reads Prisma's
      // meta.target — an assumed error shape is exactly what this must not
      // rest on. If a third unique index is added, this test is the tripwire.
      await signInAs(Role.ADMIN_IT);

      const tag = uniqueTag();
      await createAssetExpectingRedirect(
        createFields({ tag, status: AssetStatus.IN_STOCK }),
      );
      await expect(
        createAsset(
          null,
          formData(createFields({ tag, status: AssetStatus.IN_STOCK })),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: DUPLICATE_TAG_MESSAGE,
      });

      // On a CONSISTENT asset the index is never consulted: the lifecycle guard
      // rejects ASSIGNED -> ASSIGNED first. Assert the exact message, not
      // "anything but the tag one" — the loose form passes with the
      // discriminator deleted entirely (title/assertion agreement,
      // LEARNINGS §Testing).
      const asset = await aStockedAsset();
      const first = await aPerson("First");
      const second = await aPerson("Second");
      await assignAssetToPerson(
        null,
        formData({ assetId: asset.id, personId: first.id, notes: "" }),
      );
      await expect(
        assignAssetToPerson(
          null,
          formData({ assetId: asset.id, personId: second.id, notes: "" }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: ILLEGAL_TRANSITION_MESSAGE,
      });
    });

    it("reports a desynced asset's index collision as an assignment conflict", async () => {
      // ALREADY_ASSIGNED_MESSAGE *is* reachable through the action, contrary to
      // an earlier comment here — review caught the mistaken premise. On a
      // DESYNCED asset (status not ASSIGNED, yet an open assignment exists —
      // the invariant no CHECK can enforce) the guard passes IN_STOCK ->
      // ASSIGNED, the close branch is skipped because it keys on
      // `current.status === ASSIGNED`, and the insert reaches the index.
      //
      // So the discriminator earns its keep operationally, not just as defence
      // in depth, and this is the path that proves it end to end.
      await signInAs(Role.ADMIN_IT);
      const asset = await aStockedAsset();
      const holder = await aPerson("Desync Holder");
      const other = await aPerson("Desync Other");

      // Manufacture the desync exactly as a stray write would: an open
      // assignment with the asset left IN_STOCK.
      await db.assignment.create({
        data: { assetId: asset.id, personId: holder.id },
      });

      await expect(
        assignAssetToPerson(
          null,
          formData({ assetId: asset.id, personId: other.id, notes: "" }),
        ),
      ).resolves.toMatchObject({
        ok: false,
        message: ALREADY_ASSIGNED_MESSAGE,
      });
    });
  });
});
