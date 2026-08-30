#!/usr/bin/env node
/**
 * Middleware matcher probe — the negative control for the public-route gate.
 * T3 advisor condition 7 (2026-08-30).
 *
 * WHY THIS EXISTS, given src/middleware.test.ts already guards the matcher.
 *
 * That suite reads the matcher literal out of the source and compiles it with
 * plain `RegExp`. Two things are therefore invisible to it, and both change
 * what production gates while every assertion keeps passing:
 *
 *   1. `basePath` is prepended to the matcher unconditionally by Next, with no
 *      `basePath: false` opt-out. Set one and every path outside it stops
 *      being matched.
 *   2. Next's own compilation. `^literal$` is an approximation; the real
 *      pattern wraps it in an optional `_next/data` prefix group, an optional
 *      `.json|.rsc|.segments` suffix group, and an optional trailing
 *      `[/#?]` delimiter. Those are all optional, so the approximation errs
 *      only in the safe direction today — but "today" is a Next version, not
 *      a guarantee.
 *
 * So this runs against the COMPILED artefact
 * (`.next/server/middleware-manifest.json`), after the build, and brute-forces
 * the short path space rather than asserting a curated list. A curated list
 * proves the paths someone thought of; the brute force is what closes the
 * class.
 *
 * CI ordering matters and is why this is not a vitest test: .github/workflows
 * runs `pnpm test` BEFORE `pnpm build`, so at test time there is no manifest
 * to read. This runs as its own step after the build.
 *
 * Usage: node scripts/matcher-probe.mjs   (exit 0 pass, 1 fail)
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const MANIFEST = path.resolve("./.next/server/middleware-manifest.json");

/**
 * Deliberately hostile: path separators, the dot that anchors `favicon\.ico`,
 * percent and backslash for encoding tricks, the `[/#?]` delimiters the
 * compiled pattern treats as optional, and the two letters that start the
 * real exemptions (`n` for _next, `a` for api/auth).
 */
const ALPHABET = ["a", "n", "/", ".", "%", "\\", "#", "?", ":", "_"];
const MAX_SUFFIX = 4; // "/" plus 0..4 chars — 11 111 paths

/** Paths that MUST be public. Anything else public is a hole. */
const EXPECTED_PUBLIC = [
  "/",
  "/signin",
  "/signin/",
  "/api/auth",
  "/api/auth/session",
  "/api/auth/callback/resend",
  "/_next/static/chunks/main.js",
  "/_next/image",
  "/favicon.ico",
];

/**
 * Currently gated, and each is a deliberate decision rather than an accident.
 *
 * The bottom four are the live tripwire for advisor condition 8: `public/` is
 * empty today, so nothing is broken, but the first OG image, robots.txt or
 * AM-06 PWA manifest will 302 crawlers and strangers to /signin. When one of
 * those is added, the exemption list widens and this probe is what proves the
 * widening opened only what was intended.
 */
const MUST_STAY_GATED = [
  "/assets",
  "/assets/new",
  "/assets/cmxyz123",
  "/admin/users",
  "/admin/reference",
  "/me/assignments",
  "/people/cmxyz123",
  "/health",
  "/signin-foo",
  "/signinfoo",
  "/api/auth-foo",
  "/api/other",
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.json",
  "/og.png",
];

function loadMatcher() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${MANIFEST}. Run \`pnpm build\` first.\n${error.message}`,
    );
  }

  const entries = Object.values(manifest.middleware ?? {});
  if (entries.length !== 1) {
    throw new Error(
      `Expected exactly one middleware entry, found ${entries.length}. ` +
        `A second middleware changes the gate; review before widening this probe.`,
    );
  }

  const matchers = entries[0].matchers ?? [];
  if (matchers.length !== 1) {
    throw new Error(
      `Expected exactly one compiled matcher, found ${matchers.length}. ` +
        `src/middleware.ts declares one; more means something is generating them.`,
    );
  }

  return { regex: new RegExp(matchers[0].regexp), source: matchers[0].regexp };
}

function* candidates() {
  yield "/";
  let frontier = [""];
  for (let depth = 1; depth <= MAX_SUFFIX; depth += 1) {
    const next = [];
    for (const prefix of frontier) {
      for (const char of ALPHABET) {
        const suffix = prefix + char;
        next.push(suffix);
        yield `/${suffix}`;
      }
    }
    frontier = next;
  }
}

function main() {
  const { regex, source } = loadMatcher();
  const failures = [];

  // 1. Brute force: over the short path space, `/` must be the ONLY public path.
  const unexpectedlyPublic = [];
  let probed = 0;
  for (const candidate of candidates()) {
    probed += 1;
    if (!regex.test(candidate) && candidate !== "/") {
      unexpectedlyPublic.push(candidate);
    }
  }
  if (unexpectedlyPublic.length > 0) {
    failures.push(
      `${unexpectedlyPublic.length} path(s) bypass the gate besides "/": ` +
        `${unexpectedlyPublic
          .slice(0, 20)
          .map((p) => JSON.stringify(p))
          .join(", ")}`,
    );
  }

  // 2. `/` itself must be public — the whole point of the change.
  if (regex.test("/")) {
    failures.push(
      `"/" is gated. The landing page is public by design; the matcher's ` +
        `trailing quantifier must be ".+", not ".*".`,
    );
  }

  // 3. The known exemptions must stay exempt.
  for (const route of EXPECTED_PUBLIC) {
    if (regex.test(route)) {
      failures.push(`${route} should be public but is gated.`);
    }
  }

  // 4. Every real route must stay gated.
  for (const route of MUST_STAY_GATED) {
    if (!regex.test(route)) {
      failures.push(
        `${route} is PUBLIC. If that was intended, widen MUST_STAY_GATED ` +
          `deliberately — do not delete the entry to make this pass.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("matcher-probe: FAILED\n");
    console.error(`compiled matcher:\n  ${source}\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    process.exit(1);
  }

  console.log(
    `matcher-probe: ok — ${probed} paths probed, "/" is the only public one; ` +
      `${EXPECTED_PUBLIC.length} exemptions and ${MUST_STAY_GATED.length} gated routes verified.`,
  );
}

main();
