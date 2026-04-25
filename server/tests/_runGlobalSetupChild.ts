/**
 * Test-only entrypoint (Task #142).
 *
 * Spawned by server/tests/globalSetupWaitVisibility.test.ts to run
 * `globalSetup` in a fresh subprocess so the test can observe the
 * stderr lines globalSetup emits while it waits for a contended
 * advisory lock. The intermediate file exists because:
 *
 *   - The vitest config matches `**\/*.test.ts`; this filename
 *     deliberately starts with an underscore (and lacks the `.test`
 *     suffix) so vitest does not pick it up as a test file.
 *   - Spawning a real child process — rather than calling globalSetup
 *     directly inside the test — guarantees we exercise the actual
 *     two-phase acquisition path against a real Postgres connection,
 *     and that the stderr we capture is the same stderr the
 *     production code path writes to.
 *
 * Behavior:
 *   1. Invoke globalSetup. With the Task #142 testhook env vars set
 *      by the parent test, this acquires (and holds) an advisory
 *      lock on a *test-controlled* key and skips the destructive
 *      truncate.
 *   2. Once globalSetup returns its teardown, immediately call the
 *      teardown to release the lock, end the connection pool, and
 *      let Node exit cleanly.
 *
 * The script intentionally writes nothing to stdout — the parent
 * test only inspects stderr (where globalSetup itself writes its
 * progress lines), so keeping stdout silent makes the test's
 * assertions trivially unambiguous.
 */

import globalSetup from './globalSetup';

async function main(): Promise<void> {
  const teardown = await globalSetup();
  await teardown();
}

main().then(
  () => {
    process.exit(0);
  },
  (err) => {
    process.stderr.write(
      `[runGlobalSetupChild] failed: ${err?.stack ?? String(err)}\n`,
    );
    process.exit(1);
  },
);
