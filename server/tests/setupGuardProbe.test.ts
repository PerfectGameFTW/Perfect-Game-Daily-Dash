/**
 * No-op probe used by `setupGuards.test.ts`.
 *
 * `setupGuards.test.ts` spawns vitest in a subprocess to verify the
 * hard-fail safety guards in `setup.ts`. The subprocess needs SOME
 * test file to target, but that file must NOT touch the database —
 * otherwise a future weakening of the guards (e.g. `throw` swapped
 * for `console.warn`) could still cause a non-zero subprocess exit
 * via downstream DB errors, masking the regression.
 *
 * This file deliberately does nothing so the only thing that can
 * cause the subprocess to fail is the guard itself.
 *
 * It also runs as part of the normal vitest suite (and harmlessly
 * passes), so its presence costs ~0ms.
 */

import { describe, it, expect } from 'vitest';

describe('setup-guard probe (intentional no-op)', () => {
  it('does nothing — the only failure path must be setup.ts', () => {
    expect(true).toBe(true);
  });
});
