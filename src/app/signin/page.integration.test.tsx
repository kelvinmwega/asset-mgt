// @vitest-environment node
//
// /signin is the one page outside the middleware matcher, so nothing upstream
// bounces an already-authenticated visitor off it — the page must do it itself,
// or a verified magic link lands on the sign-in form (the AM-01 redirect bug).
//
// The guard cannot be a bare session check: src/app/page.tsx redirects a
// DEACTIVATED user holding a still-valid JWT to /signin, so "has session →
// redirect to /" would ping-pong those users forever. Status is DB-read here
// for the same reason requireRole reads it. Session identity mocked, DB real.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient, Role } from "@prisma/client";
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
import SignInPage from "@/app/signin/page";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const mockAuth = auth as unknown as Mock;

function render() {
  return SignInPage({ searchParams: Promise.resolve({}) });
}

/**
 * Resolves the target of the redirect a page performed, failing if it rendered
 * instead. Asserting the TARGET (not merely that some redirect happened) is the
 * point: landing on the wrong page while authenticated is the exact bug this
 * suite guards, and "/signin" would satisfy a bare NEXT_REDIRECT check.
 */
async function redirectTargetOf(page: Promise<unknown>): Promise<string> {
  const outcome = await page.then(
    () => null,
    (error: unknown) => ({ error }),
  );
  if (!outcome) {
    throw new Error("expected the page to redirect, but it rendered");
  }
  const digest = (outcome.error as { digest?: unknown }).digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT;")) {
    // A genuine failure (DB down, bad query) — surface it as itself rather
    // than as a confusing assertion mismatch.
    throw outcome.error;
  }
  // next/navigation encodes redirects as `NEXT_REDIRECT;<kind>;<target>;<status>;`
  return digest.split(";")[2];
}

describe.skipIf(!testDatabaseUrl)("signin page session guard (real DB)", () => {
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

  it("redirects an active signed-in visitor to the app", async () => {
    const user = await db.user.create({
      data: {
        email: `signin-${randomUUID()}@example.com`,
        name: "Active Staffer",
        role: Role.STAFF_RO,
      },
    });
    mockAuth.mockResolvedValue({ user: { id: user.id } });

    // /assets, not "/". `/` became the public landing page when the
    // adopter-facing site shipped; sending a completed sign-in there drops the
    // user on marketing copy, which reads as a broken magic link.
    await expect(redirectTargetOf(render())).resolves.toBe("/assets");
  });

  it("renders the form for a deactivated user rather than looping back to /assets", async () => {
    const user = await db.user.create({
      data: {
        email: `signin-${randomUUID()}@example.com`,
        name: "Deactivated Leaver",
        role: Role.STAFF_RO,
        deactivatedAt: new Date(),
      },
    });
    mockAuth.mockResolvedValue({ user: { id: user.id } });

    await expect(render()).resolves.toBeTruthy();
  });

  it("renders the form for an anonymous visitor", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(render()).resolves.toBeTruthy();
  });
});
