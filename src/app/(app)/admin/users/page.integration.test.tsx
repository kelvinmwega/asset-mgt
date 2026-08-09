// @vitest-environment node
//
// Issue #11, advisor condition 4: the "Last signed in" column reads
// `User.emailVerified`, a column NO application code writes. Its only writer
// is the Auth.js Prisma adapter, and `next-auth` here is pinned to a beta
// (5.0.0-beta.32) — so the behaviour this page depends on is upstream and can
// move under us on an upgrade.
//
// The test therefore drives the REAL adapter (`PrismaAdapter(db).updateUser`)
// against a real database and asserts the value surfaces on the real page. A
// mocked adapter would assert only that we can write a Date to a field we
// chose ourselves — it could not fail when upstream stops writing that field,
// which is the entire failure mode being guarded.
//
// FIXTURE RULE, learned the hard way in this file: every fixture is created
// INSIDE the test that uses it, and every assertion is scoped to that
// fixture's own address. `src/lib/sign-in-policy.integration.test.ts` clears
// the whole VerificationToken table (its throttle counts are global, so it
// has to), and a first version of this file staged its tokens in `beforeAll`
// and asserted on a table-wide `count()`. That passed in isolation and in most
// full-suite orderings, and failed in one — the exact shape of a test that is
// green on the machine that runs it most and red at the worst moment. There is
// no window for another file to run inside a single test body; there is one
// between `beforeAll` and the last test.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { PrismaClient, Role } from "@prisma/client";
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

import { auth } from "@/auth";
import AdminUsersPage from "@/app/(app)/admin/users/page";
import { relativeTime } from "@/lib/relative-time";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

/**
 * The expected server-rendered timestamp, built INDEPENDENTLY of the code under
 * test (review finding B2).
 *
 * These assertions previously called `exactTimestamp` to construct the value
 * they then looked for in the page — so both sides came from the same function
 * and the pair agreed with itself no matter what that function did. It was not
 * theoretical: when a formatter regression made the SSR fallback render `GMT+0`
 * instead of `UTC`, the files asserting literal strings failed and this file
 * passed.
 *
 * This is deliberately a second implementation of the same rule, not a call to
 * the first — that is the entire point, and it is why it must NOT be refactored
 * to share code with `exactTimestamp`. It encodes the property the server render
 * must hold: UTC, to the minute, labelled `UTC`.
 *
 * `renderToStaticMarkup` runs no effects, so `useViewerTimeZone` never resolves
 * and UTC is what the page must emit here.
 */
function expectedUtcTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
const mockAuth = auth as unknown as Mock;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!testDatabaseUrl)("admin users page — last signed in", () => {
  let db: PrismaClient;

  beforeAll(() => {
    execSync("pnpm exec prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "inherit",
    });
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AUTH_SECRET = "test-secret";
    process.env.AUTH_RESEND_KEY = "test-key";
    process.env.AUTH_EMAIL_FROM = "test@example.com";
    db = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  /** A provisioned user nobody has invited yet. Address unique per call — the
   *  local test database is never truncated. */
  async function provision(label: string): Promise<string> {
    const email = `signin-${label}-${randomUUID()}@example.com`;
    await db.user.create({
      data: { email, name: "Sign-in Test", role: Role.STAFF_RO },
    });
    return email;
  }

  /**
   * A magic link that was issued and never redeemed. A REDEEMED one leaves
   * nothing behind — `@auth/prisma-adapter` `useVerificationToken` deletes the
   * row — so a surviving row is exactly "sent, not used".
   */
  async function issueLink(identifier: string, createdAt: Date) {
    return db.verificationToken.create({
      data: {
        identifier,
        token: `am11-${randomUUID()}`,
        expires: new Date(createdAt.getTime() + 15 * 60 * 1000),
        createdAt,
      },
    });
  }

  async function renderAsAdmin(): Promise<string> {
    const admin = await db.user.create({
      data: {
        email: `signin-admin-${randomUUID()}@example.com`,
        name: "Sign-in Test Admin",
        role: Role.ADMIN_IT,
      },
    });
    mockAuth.mockResolvedValue({ user: { id: admin.id } });
    return renderToStaticMarkup(await AdminUsersPage());
  }

  /**
   * The TABLE row, not the page. Asserting against the whole document would let
   * another fixture's cell satisfy an assertion about this one — the table is
   * thousands of rows deep locally and one row deep in CI, which is exactly
   * the asymmetry that lets a broken guard stay green on the machine that runs
   * it most.
   *
   * Since the roster gained a phone shape this reaches the table and ONLY the
   * table: `ResponsiveTable` renders the table wrapper first, so the first
   * occurrence of an email is always the table's Email cell, and `</tr>` closes
   * that row. Every sign-in test below therefore scopes to the table — which is
   * why `cardFor` exists, so the card's copy of SignInCell is not left with no
   * guard at all.
   */
  function rowFor(html: string, email: string): string {
    const start = html.indexOf(email);
    expect(start, `no row rendered for ${email}`).toBeGreaterThanOrEqual(0);
    const end = html.indexOf("</tr>", start);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  }

  /**
   * The phone card for one user.
   *
   * The cards wrapper is rendered after the table and `UsersTable` is the last
   * element on the page, so slicing from the testid to the end of the document
   * is the whole card list; from there the same first-occurrence trick scopes
   * to one card.
   */
  function cardFor(html: string, email: string): string {
    const cardsAt = html.indexOf('data-testid="users-cards"');
    expect(cardsAt, "no card list rendered").toBeGreaterThanOrEqual(0);
    const cards = html.slice(cardsAt);
    const start = cards.indexOf(email);
    expect(start, `no card rendered for ${email}`).toBeGreaterThanOrEqual(0);
    return cards.slice(start);
  }

  it("surfaces an adapter-written emailVerified as the last sign-in", async () => {
    const email = await provision("used");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerified).toBeNull();

    // THE SEAM. Not `db.user.update` — the adapter's own updateUser, called
    // with exactly the payload @auth/core's handleLoginOrRegister sends on
    // every successful magic-link redemption:
    //   updateUser({ id, emailVerified: new Date() })
    const signedInAt = new Date(Date.now() - 3 * DAY);
    await adapterUpdate(user.id, signedInAt);

    const row = rowFor(await renderAsAdmin(), email);

    // The phrase leads...
    expect(row).toContain(relativeTime(signedInAt, new Date()));
    // ...and the exact UTC value is one hover away, never replaced.
    expect(row).toContain(expectedUtcTimestamp(signedInAt));
    expect(row).toContain(signedInAt.toISOString());
    expect(row).not.toContain("Never signed in");
  });

  it("reads a freshly provisioned user as never signed in", async () => {
    const email = await provision("never");

    const row = rowFor(await renderAsAdmin(), email);

    expect(row).toContain("Never signed in");
    // Nobody has even tried: no link was ever issued for this address.
    expect(row).toContain("No link sent yet");
    expect(row).not.toContain("Link sent");
  });

  it("tells 'link issued, never used' apart from 'never invited'", async () => {
    // The AUTH_EMAIL_FROM-drift symptom this column exists to catch: the
    // invite went out, the person never appeared. Both users below have
    // emailVerified = null, so anything reading emailVerified ALONE renders
    // them identically — which is the gap the companion signal closes.
    const invitedEmail = await provision("sent");
    const neverEmail = await provision("uninvited");
    const linkSentAt = new Date(Date.now() - 2 * HOUR);
    await issueLink(invitedEmail, linkSentAt);

    const html = await renderAsAdmin();
    const invited = rowFor(html, invitedEmail);
    const never = rowFor(html, neverEmail);

    expect(invited).toContain("Never signed in");
    expect(invited).toContain("Link sent");
    expect(invited).toContain(relativeTime(linkSentAt, new Date()));
    expect(invited).toContain(expectedUtcTimestamp(linkSentAt));

    expect(never).not.toContain("Link sent");
  });

  it("still reports a long-expired link as sent, not as never invited", async () => {
    // The TTL is 15 minutes and an admin looks at this screen hours later.
    // Filtering the companion query by `expires` would report the undelivered
    // invite as "never invited" — erasing the one signal being hunted.
    const email = await provision("stale");
    const linkSentAt = new Date(Date.now() - 5 * DAY);
    await issueLink(email, linkSentAt);

    const row = rowFor(await renderAsAdmin(), email);

    expect(row).toContain("Link sent");
    expect(row).toContain(expectedUtcTimestamp(linkSentAt));
  });

  it("matches the token identifier case-insensitively", async () => {
    // Emails are lowercased at every write (CLAUDE.md), but a row predating
    // that rule — or a provider that stops normalising — must not read as
    // "never invited", which is the one answer this column must never invent.
    const email = await provision("mixed");
    await issueLink(email.toUpperCase(), new Date());

    const row = rowFor(await renderAsAdmin(), email);

    expect(row).toContain("Link sent");
  });

  it("shows the most recent link when several were issued", async () => {
    const email = await provision("repeat");
    const oldest = new Date(Date.now() - 3 * DAY);
    const newest = new Date(Date.now() - 2 * HOUR);
    await issueLink(email, oldest);
    await issueLink(email, newest);

    const row = rowFor(await renderAsAdmin(), email);

    expect(row).toContain(expectedUtcTimestamp(newest));
    expect(row).not.toContain(expectedUtcTimestamp(oldest));
  });

  // NOTE: there is deliberately no real-DB test for "two identifiers differing
  // only in case resolve to the newest". One was written and it passed against
  // a plain last-write-wins `set` — `groupBy` returns no promised order, so it
  // was asserting against the planner, not the code. That comparison is proven
  // deterministically in `src/lib/last-link-sent.test.ts`, which feeds it both
  // permutations. A green test that cannot fail is the thing issue #12 exists
  // to stop shipping.

  it("never puts a magic-link token in the page", async () => {
    // `token` is the bearer credential in the emailed link. The query selects
    // identifier and createdAt only; this is the assertion that stays true if
    // someone later "helpfully" widens that select to the whole row.
    const email = await provision("secret");
    const { token } = await issueLink(email, new Date());

    const html = await renderAsAdmin();

    expect(html).toContain(email);
    expect(html).not.toContain(token);
  });

  it("leaves the throttle's rows exactly as it found them", async () => {
    // sign-in-policy.ts counts these same rows for the send limit. A display
    // that pruned expired or consumed tokens would silently widen that limit,
    // and nothing in the sign-in tests would notice.
    //
    // Scoped to this fixture's own identifier, deliberately: a table-wide
    // count would be measuring every other test file's tokens too.
    const email = await provision("untouched");
    await issueLink(email, new Date(Date.now() - HOUR));
    await issueLink(email, new Date());
    const where = { identifier: email };

    const before = await db.verificationToken.findMany({
      where,
      select: { token: true },
      orderBy: { token: "asc" },
    });
    expect(before).toHaveLength(2);

    await renderAsAdmin();

    expect(
      await db.verificationToken.findMany({
        where,
        select: { token: true },
        orderBy: { token: "asc" },
      }),
    ).toEqual(before);
  });

  /** The adapter call, isolated so the seam is named once. */
  async function adapterUpdate(id: string, emailVerified: Date) {
    const adapter = PrismaAdapter(db);
    expect(adapter.updateUser, "adapter lost updateUser").toBeTypeOf(
      "function",
    );
    await adapter.updateUser?.({ id, emailVerified });
  }

  it("renders both shapes of the roster", async () => {
    const email = await provision("both-shapes");
    const html = await renderAsAdmin();

    expect(html).toContain('data-testid="users-table"');
    expect(html).toContain('data-testid="users-cards"');

    // FOUR, not "at least two". The table alone supplies two occurrences (the
    // Email cell and the role select's aria-label), so a `>= 2` assertion is
    // green with the card list deleted entirely — and `ResponsiveTable` renders
    // the cards wrapper unconditionally, so the testid above is green with an
    // EMPTY card list too. Exactly four is the number that goes red if either
    // shape stops rendering this user.
    expect(html.split(email).length - 1).toBe(4);
  });

  it("gives the phone card its own sign-in state, not just the table", async () => {
    // rowFor scopes every sign-in test above to the table, so without this the
    // card's SignInCell could be deleted — or wired to the wrong field — and
    // the whole suite would stay green.
    const invited = await provision("card-invited");
    await issueLink(invited, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
    const never = await provision("card-uninvited");

    const html = await renderAsAdmin();

    expect(cardFor(html, invited)).toContain("Never signed in");
    expect(cardFor(html, invited)).toContain("Link sent");
    expect(cardFor(html, never)).toContain("Never signed in");
    expect(cardFor(html, never)).toContain("No link sent yet");
  });

  it("offers the role control in both shapes, so a phone can change a role", async () => {
    const email = await provision("role-control");
    const html = await renderAsAdmin();

    // The card is not a read-only summary — provisioning away from a desk is
    // the whole reason it exists. The aria-label is per-user and per-shape, so
    // counting it proves the control reached both.
    expect(html.split(`Role for ${email}`).length - 1).toBe(2);
  });
});
