/**
 * A database URL pinned to ONE connection, for clients that take a
 * session-scoped advisory lock (`withImportLock`, `src/lib/asset-import.ts`).
 *
 * **`pg_advisory_lock` is owned by the backend that took it, and Prisma keeps a
 * client-side connection pool even against an unpooled URL.** So the lock and
 * the matching unlock can land on different backends. When they do,
 * `pg_advisory_unlock` returns `false` — silently, it is not an error — and the
 * lock survives on the original backend until that connection closes.
 *
 * Measured against this repo's Postgres 17 container, acquiring the lock and
 * then issuing ~40 concurrent statements before unlocking:
 *
 *   default pool          lockPid=15133 unlockPid=15136 released=false  lock LEAKED
 *   connection_limit=1    lockPid=15150 unlockPid=15150 released=true   clean
 *
 * The consequence is a deadlock, not a lost mutex: the lock is over-held, so the
 * NEXT acquire in the same process blocks forever. A CLI run does one import and
 * exits, which closes the connection and hides it. The integration suite does
 * many runs in one process, which is why it surfaced there — as an intermittent
 * 20s test timeout followed by a 10s `$disconnect()` hook timeout, on CI only,
 * where pool scheduling differs.
 *
 * `withImportLock`'s `try/finally` is correct and was never the problem; it
 * cannot help when the unlock is delivered to the wrong session.
 *
 * NOTE the docblock on `withImportLock` says a session lock "REQUIRES an
 * unpooled connection". That is necessary but **not sufficient** — it rules out
 * PgBouncer moving the session, not Prisma's own pool. See the follow-up note
 * in `docs/features/AM-10/DESIGN.md` §8 about `scripts/import-assets.ts`.
 *
 * **What the pin COSTS, stated because §8 recommends production adopt it:** with
 * one connection, any *concurrent* Prisma query inside the locked section queues
 * behind it and fails with `P2024` once `pool_timeout` (10s) elapses, instead of
 * running. That is safe for the import as written — it is strictly sequential,
 * one row at a time — but it is a real constraint and not a free win. Anyone
 * adding a `Promise.all` inside `withImportLock` will meet it, and the
 * regression guard in `asset-import.integration.test.ts` deliberately churns the
 * pool with exactly that shape to keep the behaviour honest.
 */
/**
 * Accepts `undefined` and passes it through, so call sites keep the
 * `describe.skipIf(!testDatabaseUrl)` shape the real-DB suites are built on
 * rather than adding a non-null assertion for a value the skip already guards.
 */
export function singleConnectionUrl(
  url: string | undefined,
): string | undefined {
  if (!url) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}
