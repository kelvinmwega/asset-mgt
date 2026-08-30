import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { authConfig } from "@/auth.config";
import { edgeAuthConfig } from "./auth.edge";

/**
 * Guards on the edge middleware's secret handling (issue #14).
 *
 * The factory lives in src/auth.edge.ts and is exported so these can assert
 * BEHAVIOUR. An earlier revision asserted the source text instead, and the
 * advisor was right to reject it: a grep closes the spelling it was shown, not
 * the class. `?? "dev-secret"` was red-proved and guarded, and
 *
 *     const effective = secret || "dev-secret";
 *
 * would have walked straight past the same guard — throw unreachable,
 * middleware silently signing sessions with a known value. Calling the factory
 * closes the class: whatever route the code takes, either it throws or it
 * returns the real secret.
 *
 * What these still cannot prove: that the deployed edge runtime resolves
 * AUTH_SECRET at all. Nothing in this suite exercises the edge runtime, and
 * the symptom of failure — every authenticated user bounced to /signin — is
 * indistinguishable from broken sign-in, which is why #14 was worth
 * pre-empting. Only a post-promote check on production shows the happy path.
 */
describe("edgeAuthConfig", () => {
  const original = process.env.AUTH_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = original;
  });

  it("throws, naming the variable, when AUTH_SECRET is absent", () => {
    delete process.env.AUTH_SECRET;
    expect(() => edgeAuthConfig()).toThrow(/AUTH_SECRET is not set/);
  });

  it("passes the secret through when it is present", () => {
    process.env.AUTH_SECRET = "test-secret-value";
    expect(edgeAuthConfig().secret).toBe("test-secret-value");
  });

  it("never yields a truthy secret when the variable is absent", () => {
    // The class-closing assertion. Any fallback — ??, ||, an intermediate
    // variable, a second return branch — makes this produce a truthy secret
    // without throwing, and fails here regardless of how it is spelled.
    delete process.env.AUTH_SECRET;

    let yielded: unknown;
    try {
      yielded = edgeAuthConfig().secret;
    } catch {
      yielded = undefined;
    }
    expect(yielded).toBeFalsy();
  });

  it("does not mutate the shared authConfig", () => {
    // authConfig is imported by src/auth.ts too. The spread in the factory is
    // what stops next-auth's setEnvDefaults writing a secret onto it.
    process.env.AUTH_SECRET = "test-secret-value";
    edgeAuthConfig();
    expect(authConfig).not.toHaveProperty("secret");
  });
});

/**
 * One source-shape guard survives, because it defends something with no
 * runtime seam: only statically analysable `process.env.X` references survive
 * into an edge bundle, and a destructured or computed read would still return
 * the right value under vitest while resolving to undefined at the edge. That
 * is precisely the failure this issue exists to prevent, and it is invisible
 * to a behavioural test running in Node.
 */
describe("edge source shape", () => {
  // Comments stripped before matching, and finding that out cost a red test:
  // the docblocks explain why the eager `NextAuth(authConfig)` form was
  // replaced, and the negative assertion below matched the explanation.
  const codeOf = (file: string) =>
    readFileSync(path.resolve(import.meta.dirname, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

  it("reads AUTH_SECRET as a literal static member access", () => {
    const source = codeOf("auth.edge.ts");
    expect(source).toMatch(/process\.env\.AUTH_SECRET/);
    expect(source).not.toMatch(/\{[^}]*AUTH_SECRET[^}]*\}\s*=\s*process\.env/);
    expect(source).not.toMatch(/process\.env\[/);
  });

  it("passes the factory to NextAuth without calling it", () => {
    // `NextAuth(edgeAuthConfig())` would typecheck and pass every behavioural
    // test in this file while moving the read back to module scope — the exact
    // bug #14 is about. Only the source shows the difference.
    const source = codeOf("middleware.ts");
    expect(source).toMatch(/NextAuth\(\s*edgeAuthConfig\s*\)/);
    expect(source).not.toMatch(/NextAuth\(\s*edgeAuthConfig\(\)\s*\)/);
    expect(source).not.toMatch(/NextAuth\(\s*authConfig\s*\)/);
  });

  it("keeps the edge config free of server-only modules", () => {
    // src/lib/env.ts imports "server-only" and zod-parses the whole of
    // process.env. Importing it here would break the edge bundle.
    const source = codeOf("auth.edge.ts");
    expect(source).not.toMatch(/from\s+["']@\/lib\/env["']/);
    expect(source).not.toMatch(/["']server-only["']/);
  });
});

/**
 * The public-route matcher (adopter-facing landing page, `/`).
 *
 * These execute the matcher rather than grepping it, for the reason the
 * docblock above gives: a source assertion closes the spelling it was shown,
 * not the class. Compiling the pattern and running paths through it means any
 * future rewrite — a different quantifier, an added alternation branch, a
 * reordered lookahead — is judged on what it actually gates.
 *
 * `config.matcher` is read from the real module export, not retyped here, so
 * the test cannot drift from the middleware it defends.
 *
 * Approximation, stated: Next compiles matcher strings with path-to-regexp.
 * This pattern is raw regex apart from the leading slash, so `^…$` is faithful
 * for the quantifier semantics under test. What this does NOT prove is that
 * the deployed edge runtime applies the matcher identically — only a request
 * against a preview deployment shows that.
 */
describe("public matcher", () => {
  // The matcher is read out of the source rather than imported: importing
  // middleware.ts pulls next-auth's edge entrypoint into the node test
  // environment and the suite dies on a module resolution error before a
  // single assertion runs. Extracting the literal keeps the assertions
  // behavioural — the pattern below is compiled and executed, not grepped —
  // and the extraction itself is asserted, so a refactor that moves or
  // multiplies the matcher fails loudly instead of quietly testing nothing.
  const matcherRegex = () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "middleware.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const block = source.match(/matcher:\s*\[([\s\S]*?)\]/);
    expect(
      block,
      "middleware.ts no longer declares matcher: [...]",
    ).not.toBeNull();

    const literals = [...block![1].matchAll(/"(?:[^"\\]|\\.)*"/g)].map(
      (match) => JSON.parse(match[0]) as string,
    );
    expect(literals).toHaveLength(1);

    return new RegExp(`^${literals[0]}$`);
  };

  // Gated means "middleware runs on it". The middleware only authenticates;
  // requireRole in each page and action is what authorises. A route dropping
  // off this list is a route that lost its session gate.
  const GATED = [
    "/assets",
    "/assets/new",
    "/assets/cmxyz123",
    "/admin/users",
    "/admin/reference",
    "/me/assignments",
    "/people/cmxyz123",
    "/health",
    // Single character: the boundary case the `.+` quantifier turns on. If a
    // future rewrite opens the root by trimming a character rather than by
    // requiring one, this is the assertion that catches it.
    "/a",
    // The anchoring the advisor conditioned on, still holding.
    "/signin-foo",
    "/signinfoo",
    "/api/auth-foo",
    "/api/other",
  ];

  const PUBLIC = [
    "/signin",
    "/signin/",
    "/api/auth",
    "/api/auth/session",
    "/api/auth/callback/resend",
    "/_next/static/chunks/main.js",
    "/_next/image",
    "/favicon.ico",
  ];

  it("leaves the root public", () => {
    // Red-proved: reverting the quantifier to `.*` matches "" here and this
    // fails, which is the whole change in one assertion.
    expect(matcherRegex().test("/")).toBe(false);
  });

  it.each(GATED)("gates %s", (route) => {
    expect(matcherRegex().test(route)).toBe(true);
  });

  it.each(PUBLIC)("exempts %s", (route) => {
    expect(matcherRegex().test(route)).toBe(false);
  });

  it("opens exactly one path and no more", () => {
    // The class-closing assertion. Opening the root by widening the
    // alternation — the tempting fix — tends to open a subtree with it; any
    // such change makes some GATED entry fall through and fails here as well
    // as above. Kept separate so the failure message names the count.
    const regex = matcherRegex();
    const opened = [...GATED, "/"].filter((route) => !regex.test(route));
    expect(opened).toEqual(["/"]);
  });
});
