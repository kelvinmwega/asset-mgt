// @vitest-environment node
//
// PLAN.md task 5 / advisor conditions 9 and 11.
//
// THE assertion this file exists for: for a STAFF_RO viewer, the asset detail
// page and the register FETCH no assignment and no person data — not "fetch it
// and hide it". So the assertions are on the QUERIES AND THEIR RESULTS, never on
// the rendered HTML: rendered-HTML assertions pass just as well when the data is
// loaded and merely not printed, which is exactly the bug they would need to
// catch. Every Prisma model operation the page issues is recorded through a
// client extension and inspected.
//
// Real DB, not mocks: what is being asserted is which tables the page touches,
// and a mock returns the same canned rows whatever the query said.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AssetStatus, PrismaClient, Role } from "@prisma/client";
import { renderToStaticMarkup } from "react-dom/server";
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

// The page (and requireRole) read their client from here; handing them the
// recording client is what makes every query it issues observable.
vi.mock("@/lib/db", () => ({ getDb: () => recordingDb }));

import { auth } from "@/auth";
import { assignAsset } from "@/lib/asset-admin";
import AssetDetailPage from "./[id]/page";
import AssetsPage from "./page";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mockAuth = auth as unknown as Mock;

type RecordedCall = {
  model: string | undefined;
  operation: string;
  args: unknown;
  result: unknown;
};

let calls: RecordedCall[] = [];
let recordingDb: PrismaClient;

describe.skipIf(!testDatabaseUrl)("asset assignment UI (real DB)", () => {
  let db: PrismaClient;
  let assignedAssetId: string;
  let stockAssetId: string;
  let assignedTag: string;
  let categoryId: string;
  const personName = `Holder ${randomUUID()}`;
  const personEmail = `holder-${randomUUID()}@example.com`;
  const personRef = `EMP-${randomUUID().slice(0, 8)}`;
  const actorEmail = `nameless-actor-${randomUUID()}@example.com`;

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
    recordingDb = db.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const result = await query(args);
            calls.push({ model, operation, args, result });
            return result;
          },
        },
      },
    }) as unknown as PrismaClient;

    const category = await db.category.create({
      data: { name: `Assignment UI ${randomUUID()}` },
    });
    categoryId = category.id;
    const person = await db.person.create({
      data: { name: personName, email: personEmail, employeeRef: personRef },
    });
    // An actor with NO name: on main this is the account whose email leaked to
    // every staff user through `event.actor?.name ?? event.actor?.email`.
    const actor = await db.user.create({
      data: { email: actorEmail, role: Role.ADMIN_IT },
    });

    assignedTag = `ASG-${randomUUID().slice(0, 12)}`;
    const [assigned, stock] = await Promise.all([
      db.asset.create({
        data: {
          categoryId: category.id,
          make: "Assignment",
          model: "Held",
          tag: assignedTag,
          status: AssetStatus.IN_STOCK,
        },
      }),
      db.asset.create({
        data: {
          categoryId: category.id,
          make: "Assignment",
          model: "Stock",
          tag: `STK-${randomUUID().slice(0, 12)}`,
          status: AssetStatus.IN_STOCK,
        },
      }),
    ]);
    assignedAssetId = assigned.id;
    stockAssetId = stock.id;

    // Through the real write path, so the ASSIGNED event carries the nameless
    // actor exactly as production would write it.
    await assignAsset(db, {
      assetId: assignedAssetId,
      personId: person.id,
      actorId: actor.id,
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  async function signInAs(role: Role) {
    const user = await db.user.create({
      data: {
        email: `viewer-${randomUUID()}@example.com`,
        name: "Viewer",
        role,
      },
    });
    mockAuth.mockResolvedValue({ user: { id: user.id } });
    return user;
  }

  /** Renders a page and returns everything it asked the database for. */
  async function record(element: Promise<React.ReactElement>) {
    calls = [];
    const html = renderToStaticMarkup(await element);
    const recorded = calls;
    return {
      html,
      models: recorded.map((call) => call.model),
      // Args only: proves the page never REQUESTED person-shaped data, which is
      // what catches a nested `include` that JSX happens not to render.
      requested: JSON.stringify(
        recorded.map(({ model, operation, args }) => ({
          model,
          operation,
          args,
        })),
      ),
      // Args and rows together: proves no person data came BACK either.
      //
      // NOT named `payload`, which it was until #19 review: every reader took
      // that for the RSC payload — the thing serialised to the BROWSER — and
      // read assertions on it as claims about what crosses the network. It is
      // the opposite end of the request. Nothing in this file observes the RSC
      // payload at all: `renderToStaticMarkup` produces HTML and no flight
      // data, so "this value never reaches the client" is not a claim any test
      // here can make.
      dbTraffic: JSON.stringify(recorded),
    };
  }

  const renderDetail = (id: string) =>
    record(AssetDetailPage({ params: Promise.resolve({ id }) }));
  // Scoped to this file's own category. The register paginates at 50 rows
  // (AM-07), and this database is never truncated — so an unfiltered render
  // returns page 1 of thousands and the fixtures are not on it. That turned
  // the ADMIN_IT twin below red, which is the useful direction: had it been
  // the STAFF_RO assertions that stopped reaching their fixtures, they would
  // have gone on passing while proving nothing at all.
  const renderRegister = () =>
    record(AssetsPage({ searchParams: Promise.resolve({ categoryId }) }));

  describe("STAFF_RO", () => {
    it("fetches no assignment and no person data on the asset detail page", async () => {
      await signInAs(Role.STAFF_RO);

      const { html, models, requested, dbTraffic } =
        await renderDetail(assignedAssetId);

      // The tables are never touched…
      expect(models).not.toContain("Assignment");
      expect(models).not.toContain("Person");
      // …nor reached by a nested include, on any query the page made.
      expect(requested).not.toMatch(/assignment|person|actor/i);
      // …and nothing person-shaped came back.
      expect(dbTraffic).not.toContain(personName);
      expect(dbTraffic).not.toContain(personRef);
      expect(dbTraffic).not.toContain(personEmail);
      expect(dbTraffic).not.toContain(actorEmail);

      // The page still works: the asset and its status history render, with a
      // neutral label where a person would otherwise appear.
      expect(html).toContain(assignedTag);
      // The history's own Change cell, not the bare status label: "Assigned"
      // alone also appears in the Status field above, so asserting on it would
      // still pass if the history table vanished entirely. The arrow string is
      // rendered nowhere else. (AM-09 relabelled the event type from the raw
      // `ASSIGNED` this used to assert on.)
      expect(html).toContain("In stock → Assigned");
      expect(html).toContain(">IT<");
      expect(html).not.toContain(personName);
    });

    it("fetches no assignment and no person data on the register", async () => {
      await signInAs(Role.STAFF_RO);

      const { html, models, requested, dbTraffic } = await renderRegister();

      expect(models).not.toContain("Assignment");
      expect(models).not.toContain("Person");
      expect(requested).not.toMatch(/assignment|person/i);
      expect(dbTraffic).not.toContain(personName);
      expect(html).not.toContain("Held by");
      expect(html).not.toContain(personName);
    });
  });

  // The falsifiability twin. Without it, the assertions above would pass just as
  // well against a page that fetches nothing for anybody — including a page
  // whose holder feature is simply broken.
  describe("ADMIN_IT (proves the STAFF_RO assertions can fail)", () => {
    it("does fetch the holder and the holder history on the detail page", async () => {
      await signInAs(Role.ADMIN_IT);

      const { html, models, dbTraffic } = await renderDetail(assignedAssetId);

      expect(models).toContain("Assignment");
      expect(dbTraffic).toContain(personName);
      expect(dbTraffic).toContain(personRef);
      expect(html).toContain(personName);
      expect(html).toContain(personRef);
    });

    it("does fetch the holder on the register", async () => {
      await signInAs(Role.ADMIN_IT);

      const { html, models, dbTraffic } = await renderRegister();

      expect(models).toContain("Assignment");
      expect(dbTraffic).toContain(personName);
      expect(html).toContain("Held by");
      expect(html).toContain(personName);
    });
  });

  // Advisor condition 11: the actor's email is a tiered field like any other.
  describe("actor identity", () => {
    it("selects the actor's email for ADMIN_IT only", async () => {
      await signInAs(Role.ADMIN_IT);
      const admin = await renderDetail(assignedAssetId);
      expect(admin.dbTraffic).toContain(actorEmail);

      for (const role of [Role.PROCUREMENT, Role.FINANCE]) {
        await signInAs(role);
        const view = await renderDetail(assignedAssetId);
        // The history is still there — it just names no one. Asserted via the
        // Change cell for the same reason as the STAFF_RO case above: the bare
        // label is not unique to the history table.
        expect(view.html).toContain("In stock → Assigned");
        expect(view.dbTraffic).not.toContain(actorEmail);
        expect(view.html).not.toContain(actorEmail);
      }
    });

    it("shows a nameless actor as IT rather than as their email address", async () => {
      await signInAs(Role.FINANCE);

      const { html } = await renderDetail(assignedAssetId);

      expect(html).toContain(">IT<");
      expect(html).not.toContain(actorEmail);
    });
  });

  // AC 1: an ASSIGNED asset offers return (to stock OR to repair) and retire,
  // and NO separate "send to repair" — that move is the repair-bound return.
  //
  // #10 moved every lifecycle form into a dialog, so an offered move is now a
  // TRIGGER rather than an inline form heading, and the trailing ellipsis is
  // part of the affordance. The moves behind `More` reach static markup because
  // that menu renders inline and always mounted (`DropdownMenu inline`); a
  // portalled menu would turn the positive assertions below red, and they must
  // not be loosened to let it. Same claim, different selector — with one half of it
  // relocated: Radix mounts dialog content only once open and portals it, so
  // nothing inside a dialog reaches server-rendered markup. What the return form
  // asks for once opened (both destinations, one action) and what the picker
  // shows (employeeRef, never an email) are asserted in
  // `[id]/lifecycle-actions.test.tsx`, which can open them.
  describe("lifecycle moves offered", () => {
    it("offers assign, send to repair and retire on an IN_STOCK asset", async () => {
      await signInAs(Role.ADMIN_IT);

      const { html, models, dbTraffic } = await renderDetail(stockAssetId);

      expect(html).toContain(">Assign…<");
      expect(html).toContain(">Send to repair…<");
      expect(html).toContain(">Retire asset…<");
      expect(html).not.toContain(">Take it back…<");
      // The picker's people are fetched for this status — the query is only
      // made when the ASSIGN move is offered — and for ADMIN_IT the rows come
      // back carrying an email, because `personSelectFor(ADMIN_IT)` selects
      // one. Two facts about the SERVER, and that is the whole of it:
      //
      //   1. the DB is asked for people here, and answers with an address;
      //   2. the server-rendered markup prints no address.
      //
      // What this does NOT show is that the address stops at the server. That
      // would be a claim about the RSC payload, and nothing in this file
      // observes one (see `record`). It is also not what makes the second
      // assertion pass: the picker lives inside a Radix dialog, which mounts
      // nothing until it is opened, so its contents are absent from static
      // markup no matter what the props hold.
      //
      // The address is in fact dropped — page.tsx maps the rows to
      // `PickerPerson`, which has no email field — but the guard on that is
      // the type, checked by tsc, NOT this test. Do not read these three
      // lines as a client-boundary assertion; they are a server-side one.
      expect(models).toContain("Person");
      expect(dbTraffic).toContain(personEmail);
      expect(html).not.toContain(personEmail);
    });

    it("offers return-to-stock, return-to-repair and retire on an ASSIGNED asset", async () => {
      await signInAs(Role.ADMIN_IT);

      const { html } = await renderDetail(assignedAssetId);

      // One move covering both ways out of ASSIGNED that are not retirement.
      expect(html).toContain(">Take it back…<");
      expect(html).toContain(">Retire asset…<");
      // Not a second, parallel path out of ASSIGNED.
      expect(html).not.toContain(">Send to repair…<");
      expect(html).not.toContain(">Assign…<");
    });
  });

  describe("every holder, at both widths", () => {
    it("renders both shapes for a viewer allowed to see holders", async () => {
      await signInAs(Role.ADMIN_IT);
      const { html } = await renderDetail(assignedAssetId);

      expect(html).toContain('data-testid="holders-table"');
      expect(html).toContain('data-testid="holders-cards"');
      // The holder reaches both shapes from the one assignments query. The
      // name also appears in the custody card above, so this is a floor
      // rather than an equality — what it catches is a card list that
      // rendered nothing.
      expect(html.split(personName).length - 1).toBeGreaterThanOrEqual(3);
    });

    it("renders NEITHER shape for STAFF_RO", async () => {
      await signInAs(Role.STAFF_RO);
      const { html } = await renderDetail(assignedAssetId);

      // The whole section sits inside `canSeeHolders` and the assignments were
      // never fetched, so the card list cannot leak what the table does not
      // show. Asserting both testids is what stops a later refactor from
      // hoisting the cards out of that branch.
      expect(html).not.toContain('data-testid="holders-table"');
      expect(html).not.toContain('data-testid="holders-cards"');
      expect(html).not.toContain(personName);
    });
  });
});
