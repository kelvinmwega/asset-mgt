import NextAuth from "next-auth";
import { edgeAuthConfig } from "@/auth.edge";

/**
 * Deny-by-default authentication gate (docs/DESIGN.md security constraint 1).
 *
 * The matcher gates EVERYTHING except Auth.js routes and static assets. The
 * middleware only authenticates (session present or not) — authorisation is
 * always requireRole() reading the role from the DB inside the handler; the
 * JWT is never trusted for roles.
 *
 * Uses the edge-safe config only: no Prisma import may ever reach this file.
 *
 * `edgeAuthConfig` is passed as a FUNCTION, never called here. The object form
 * of NextAuth() runs `setEnvDefaults` at module scope, reading AUTH_SECRET
 * once per edge isolate at module evaluation; the function form defers it to
 * request time, which is also the only form in which the factory's throw does
 * not fire during a zero-env build. Why the secret is handled there rather
 * than here, and what is and is not known about the production failure it
 * fixes, is documented in src/auth.edge.ts (issue #14).
 */
export default NextAuth(edgeAuthConfig).auth;

export const config = {
  // /signin and the adopter-facing landing page at / are the ONLY public
  // pages; everything else stays behind the deny-by-default session gate. The
  // signin and api/auth exclusions are anchored with (?:/|$) so only the
  // exact segment (and its children, for api/auth) is public — a future
  // /signin-foo or /api/auth-foo route stays gated (advisor condition).
  //
  // The root is opened by the trailing quantifier, `.+` rather than `.*`, and
  // NOT by adding it to the alternation above. This is the whole reason the
  // change is small: the alternation is a prefix list, and every anchoring
  // trick that makes "/" mean the root and not the root-as-prefix has to be
  // spelled correctly under a negative lookahead — get it slightly wrong and
  // the gate opens for a whole subtree in silence. `.+` sidesteps that class
  // entirely. It requires at least one character after the leading slash, so
  // exactly one path stops matching: "/" itself. Every other route, including
  // any single-character route, still has a non-empty remainder and stays
  // gated. src/middleware.test.ts §"public matcher" asserts both halves.
  // TWO THINGS THIS GUARD CANNOT SEE (T3 advisor, 2026-08-30). Both live
  // outside the pattern, so src/middleware.test.ts keeps passing while either
  // one silently changes what is gated:
  //
  // 1. `basePath` is prepended to this matcher unconditionally, with no
  //    `basePath: false` opt-out. Set one in next.config.ts and every path
  //    outside it stops being matched. next.config.ts is `{}` today; adding
  //    anything to it means re-running the compiled-artefact probe.
  // 2. Middleware runs BEFORE all rewrites (headers → redirects → middleware
  //    → beforeFiles → …). A rewrite mapping `/` onto an app route would serve
  //    that route on the one pathname this gate no longer inspects. Today the
  //    (app) layout's requireRole is the backstop; the middleware gate would
  //    be bypassed entirely.
  //
  // Neither is a hole now. Both are why the probe in scripts/matcher-probe.mjs
  // runs against the COMPILED manifest after the build, not against this file.
  matcher: [
    "/((?!api/auth(?:/|$)|signin(?:/|$)|_next/static|_next/image|favicon\\.ico).+)",
  ],
};
