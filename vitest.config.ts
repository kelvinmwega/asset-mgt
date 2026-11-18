import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Next's tsconfig sets jsx: preserve; vitest (vite 8 / rolldown-oxc) must
  // compile the JSX itself since no framework plugin is in play here.
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      // `server-only` throws outside React Server Components; stub it so
      // server modules stay importable under vitest.
      "server-only": path.resolve(
        import.meta.dirname,
        "test/server-only-stub.ts",
      ),
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Agent worktrees live under .claude/worktrees/, i.e. INSIDE the repo,
      // and a local pnpm store can appear at .pnpm-store/. Both contain whole
      // copies of the source tree, so the default include globs collect
      // another branch's tests — 264 failing files from work not on this
      // branch. CI never sees any of this (fresh checkout, no worktrees), so
      // it only ever breaks local runs.
      "**/.claude/**",
      "**/.pnpm-store/**",
    ],
    // Integration tests share one real test database, and TWO things depend on
    // files not interleaving. Both are listed because removing this setting
    // needs to surface both dependents, not just whichever is remembered:
    //
    // 1. The last-admin guard counts active admins across the whole User
    //    table, so a file creating ADMIN_IT rows races another staging a
    //    "last admin" scenario.
    // 2. sign-in-policy.integration.test.ts clears the entire
    //    VerificationToken table — the throttle's caps are global, so no
    //    scoped `where` would do — while admin/users/page.integration.test.tsx
    //    reads and writes those same rows (issue #11).
    //
    // Run test files sequentially; the suite is small.
    fileParallelism: false,
    // 5s is a unit-test default and these are not unit tests: each real-DB file
    // renders a whole page against Postgres, and the register renders EVERY
    // asset because pagination is still deferred (#8).
    //
    // The test database is never truncated, so it accumulates fixtures run over
    // run — it was at 4,318 assets when this was raised, and the register test
    // timed out at 5,007ms. CI cannot see this: its service container is fresh
    // every run, so the suite there renders a handful of rows and stays green
    // while local runs get slower for every developer, forever. Raising the
    // ceiling buys time; #8 is what actually fixes it, because a paginated
    // register renders one page whatever the table holds.
    testTimeout: 20_000,
  },
});
