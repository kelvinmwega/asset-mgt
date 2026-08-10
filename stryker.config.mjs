// Mutation testing over the guard-bearing modules (issue #12).
//
// WHY THIS EXISTS
// ---------------
// "Regression guards must be falsifiable" is a six-time recurrence in this
// project (LEARNINGS §Testing). The named pattern: a guard written at the same
// time as the code it defends tends to assert the thing the author was already
// thinking about, not the thing that can break. Manual red-proving catches it —
// AM-09 caught all three of its instances that way — but it only works when
// someone remembers to do it, every time. Stryker removes the "remembers".
//
// SCOPE IS DELIBERATELY SMALL. Only modules that encode an invariant a test
// claims to defend are mutated. A whole-tree run would be slow and mostly noise
// about JSX class strings.
//
// Run: pnpm test:mutation   (requires TEST_DATABASE_URL — see below)

// ---------------------------------------------------------------------------
// THE TEST_DATABASE_URL TRAP
// ---------------------------------------------------------------------------
// Three of the five mutated modules are covered ONLY by real-DB integration
// tests gated on `describe.skipIf(!process.env.TEST_DATABASE_URL)`. Without the
// variable those suites do not fail — they silently *skip*. Every mutant in
// those modules then survives and the run reports a number that looks like a
// terrible score but is actually no score at all: the tests that would have
// killed those mutants never ran. A threshold tuned against such a run is
// meaningless in both directions.
//
// So the config refuses to load without it. A hard throw is the only form of
// this check that cannot be ignored; a warning would be read once and then
// scrolled past forever.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    [
      "TEST_DATABASE_URL is not set — refusing to run mutation testing.",
      "",
      "asset-admin.ts, person-visibility.ts and sign-in-policy.ts are covered",
      "only by real-DB integration tests, which skip (not fail) without this",
      "variable. Running anyway would report a score computed from tests that",
      "never ran.",
      "",
      "Local:  docker compose up -d",
      "        TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/asset_mgt_test \\",
      "          pnpm test:mutation",
      "CI:     .github/workflows/mutation.yml sets it from the service container.",
    ].join("\n"),
  );
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  testRunner: "vitest",
  // Named explicitly rather than left to the default `@stryker-mutator/*` glob:
  // under pnpm's non-flat node_modules, core resolves plugins from its own
  // nested directory, where the vitest runner is not a sibling. The default
  // glob finds nothing and Stryker dies with "no TestRunner plugins were
  // loaded", which reads like a missing install rather than a layout problem.
  plugins: ["@stryker-mutator/vitest-runner"],
  reporters: ["html", "json", "clear-text", "progress"],
  clearTextReporter: { maxTestsToLog: 1 },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },

  // ---------------------------------------------------------------------
  // The guard-bearing modules. Each encodes an invariant a test claims to
  // defend; none of them is here because it happened to be under-covered.
  // ---------------------------------------------------------------------
  mutate: [
    // The transition map and the tag exemptions.
    "src/lib/asset-lifecycle.ts",
    // The PII chokepoint — the one place a Person select carrying PII exists.
    "src/lib/person-visibility.ts",
    // The `returnedAt IS NULL` predicate and its `count === 1` assertion.
    "src/lib/asset-admin.ts",
    // The throttle windows.
    "src/lib/sign-in-policy.ts",
    // The four §5 guards (second act, dismiss-never-submits, locked in
    // flight, result shown).
    "src/components/confirm-action-dialog.tsx",
    // AM-04, added IN THE STORY THAT WROTE THEM (advisor condition C33). A
    // scoped mutate list does not grow with the codebase: modules land, the
    // list stays as it was, and the newest guards — the least hand-red-proved
    // of any in the tree — are the ones nobody mutates. These four carry the
    // import's whole guard surface.
    //
    // The status map's undefined branch, the strict decimal regex, the serial
    // date conversion, the header check.
    "src/lib/import-map.ts",
    // The zip caps and the streaming abort, the sheet resolution, the
    // date1904 rejection, the cell-type allowlist.
    "src/lib/import-xlsx.ts",
    // The exactly-one-IMPORTED-event write, exact-unique-or-nothing holder
    // resolution, and the advisory lock.
    "src/lib/asset-import.ts",
    // Insert-only idempotency, the dry-run rollback, and the cache flags that
    // keep a rolled-back id from reaching the next row.
    "src/lib/import-run.ts",

    // AM-10. Both enforce a rule rather than compute a value, and both shipped
    // with a guard that did not guard — the C1 zone list stayed green when the
    // production line it names was reverted, and a `toBeGreaterThan(1)` control
    // passed against a component ignoring the viewer's zone entirely. Review
    // caught both; nothing mechanical would have.
    //
    // Added here in the delivery that created them, which is the standing rule
    // (LEARNINGS §Testing, mutation-testing item 5): a scope list does not grow
    // with the codebase, so the newest guards — the ones least likely to have
    // been red-proved by hand — are precisely the ones that fall outside it.
    //
    // `calendar-date.ts` is the UTC pin for calendar dates: mutating away
    // `timeZone: "UTC"` must kill a mutant, or a purchase date can shift a day
    // per viewer. `relative-time.ts` holds the zone label and the UTC fallback
    // that every server and no-JS render depends on.
    "src/lib/calendar-date.ts",
    "src/lib/relative-time.ts",
  ],

  vitest: { configFile: "vitest.config.ts" },

  // `perTest` narrows each mutant to the tests that actually covered it, which
  // is what makes a real-DB run affordable at all. Static mutants (the
  // transition map, the throttle constants) are deliberately NOT ignored even
  // though they force a full reload plus a full suite run: they ARE the guards
  // this whole exercise exists to falsify.
  coverageAnalysis: "perTest",
  ignoreStatic: false,

  // Integration tests run `prisma migrate deploy` in beforeAll and share one
  // Postgres; the suite sets `fileParallelism: false` for that reason. Parallel
  // Stryker workers would reintroduce exactly the race the vitest config
  // disables, and cross-worker interference shows up as bogus survivors.
  concurrency: 1,
  timeoutMS: 60_000,
  timeoutFactor: 2,

  tempDirName: ".stryker-tmp",
  htmlReporter: { fileName: "reports/mutation/index.html" },
  // Stryker copies the whole tree into its sandbox, and a local pnpm store
  // lives INSIDE the repo at `.pnpm-store/` for anyone who has configured one.
  // It contains unix sockets, which `copyfile` cannot copy — the run dies with
  // `ENOTSUP: operation not supported on socket` before a single mutant is
  // tested. Found while merging this PR on a machine that had one; the
  // original branch did not, which is exactly the kind of works-on-my-machine
  // difference that makes a tool look broken to the next person.
  // `.git` is excluded for size, not correctness.
  ignorePatterns: [".pnpm-store", ".git", ".next", "reports"],
  // Explicit, not defaulted: the sandbox is a full copy of the tree with
  // `// @ts-nocheck` atop every file, and .husky/pre-push runs a full-repo
  // `pnpm lint && pnpm typecheck`. The default (`true`) leaves the sandbox
  // behind after a FAILED run — which is exactly when someone is most likely
  // to try to push. `.gitignore`, the eslint `ignores` and the tsconfig
  // `exclude` are the belt to this braces; keep all four in sync.
  cleanTempDir: "always",

  // ---------------------------------------------------------------------
  // TRIAGE — done once, 2026-08-02.
  // ---------------------------------------------------------------------
  // First run: 80.10% over 382 mutants, 17m14s. After triage: 97.06%, 9m50s
  // (asset-lifecycle, person-visibility and sign-in-policy at 100%;
  // asset-admin 97.92%; confirm-action-dialog 70%). What it found, and what
  // was done about each finding:
  //
  // KILLED (new tests; each is annotated at the test with what it defends):
  //  - person-visibility.ts — `employeeRef: role !== STAFF_RO` could be
  //    replaced with `employeeRef: true`, fetching a read-only staff viewer the
  //    employee reference the docblock's own table denies them, and NOTHING
  //    went red. The page tests assert on what is rendered; CLAUDE.md's rule is
  //    that the data must not be FETCHED. Now covered by the select-shape
  //    matrix in src/lib/person-visibility.test.ts. This is the single most
  //    valuable thing this exercise produced.
  //  - asset-lifecycle.ts — the whole body of `conditionNotesRequiredFor` could
  //    be replaced with `return undefined`. Its repair clause is re-checked
  //    downstream, which kept the integration tests green; its POOR/DEFECTIVE
  //    clauses had no second enforcer anywhere. Now a 5×5 matrix.
  //  - asset-admin.ts — `.trim()` could be deleted from the repair-bound note
  //    guard, because the only test exercising whitespace went through Zod,
  //    which trims before the write layer sees it. (The AM-02 "proven red for
  //    NULL but not ''" recurrence, again.) Also: three "id not found"
  //    branches, the tag guard's accept direction, and fifteen mutants inside
  //    the field-diff helper whose Date/Decimal/null branches no fixture
  //    reached.
  //  - sign-in-policy.ts — `15 * 60 * 1000` could become `15 / 60 * 1000` and
  //    the throttle tests stayed green, because they derive their own fixture
  //    timestamps from the same constants. The windows are now pinned to
  //    wall-clock values.
  //  - confirm-action-dialog.tsx — the hidden-field inputs could all vanish and
  //    all four §5 guards still passed. A confirm submitted without its subject
  //    is not a weaker dialog, it is a broken one.
  //
  // IGNORED — 42 mutants, every one carrying its reason at the SITE as a
  // `// Stryker disable` comment, never in a list here. A reason living next to
  // the code is the only kind that gets re-read when the code changes; a list
  // in a config file rots exactly the way a coverage exclusion list does. The
  // categories, so a reviewer knows what to expect:
  //  - Error message prose and `.name` (asset-admin.ts). Error identity here is
  //    the CLASS; nothing branches on the text.
  //  - Tailwind class names and button variants (confirm-action-dialog.tsx).
  //  - The Escape half of "cannot dismiss while pending", which is implemented
  //    twice over. No test can kill either layer while the other stands — that
  //    is Stryker describing redundancy correctly, and the behaviour itself IS
  //    tested.
  //  - Equivalent mutants: Prisma `undefined` spreads, the null short-circuit
  //    in the field diff, a `&&` that cannot differ from `||` for typed columns.
  //  - Branches unreachable by construction: the both-opened-and-closed throw
  //    (assertTransition forbids ASSIGNED -> ASSIGNED), and the
  //    ASSIGNED-with-no-open-assignment branch, where reaching it means leaving
  //    a permanently inconsistent row in a test database that is never
  //    truncated.
  //
  // LEFT VISIBLY RED, deliberately — 10 mutants, all NoCoverage/Survived. These
  // are gaps, not equivalences, and burying them in the ignore list would be
  // the whole failure this exercise exists to prevent:
  //  - confirm-action-dialog.tsx, the overlay dismissal route (6). Nothing
  //    exercises it at all, and jsdom cannot: Radix sets `pointer-events: none`
  //    on <body>, so userEvent refuses the click. Belongs in a real-browser
  //    smoke (LEARNINGS §Testing).
  //  - asset-admin.ts, `createOpenAssignmentTx`'s `checkedOutAt` (4). No
  //    production caller until AM-04's back-dated import, which owns closing it.
  //
  // HOW TO RE-TRIAGE: read `reports/mutation/mutation.json`, group by
  // `status !== 'Killed'`, and — this matters — also group the `Ignored` ones by
  // line and check they land only where a directive was written. A `Stryker
  // restore` comment that ends up as a TRAILING comment is silently dropped and
  // its `disable` runs to end of file; that happened here and inflated the
  // score by ~5 points with no warning of any kind.
  //
  // ---------------------------------------------------------------------
  // Threshold. `break` fails the run.
  //
  // 95, against a measured 97.06 — about two points, or seven mutants, of
  // slack. Chosen from the measurement, not as a round aspiration: the job of
  // this gate is to catch a NEW guard that nothing can falsify (add six
  // unkillable mutants and the score lands at ~95.4, which is red), while
  // leaving enough room that an ordinary feature commit does not flap it.
  //
  // Raise it when a run comfortably clears it. Do NOT lower it to make a red
  // run green — that is the same move as adding an unexplained entry to a
  // coverage exclusion list, and the survivor it is hiding is exactly the thing
  // this whole file was built to show you.
  // ---------------------------------------------------------------------
  thresholds: { high: 98, low: 90, break: 95 },
};

export default config;
