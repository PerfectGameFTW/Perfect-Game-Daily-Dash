/**
 * Tests for the TOTP brute-force / recovery-code-burst alerter
 * (Task #132).
 *
 * Mirrors the shape of `emailAlert.test.ts` and
 * `serverErrorAlert.test.ts`: rolling window, threshold, cooldown,
 * silent-when-unconfigured. The pieces unique to this alerter are
 *   - per-account (not global) counting and cooldown,
 *   - the `attemptCount`-based "single-event tripwire" so a single
 *     log line carrying attemptCount >= threshold fires immediately,
 *   - separate failure vs recovery thresholds and webhook copy,
 *   - failure events on user A do not silence recovery alerts on
 *     user A or anything on user B.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { totpAuthAlerter } from '../services/totpAuthAlert';

describe('totpAuthAlerter', () => {
  beforeEach(() => {
    totpAuthAlerter.reset();
  });

  it('fires once per-account login_failure count crosses threshold within window', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 5,
        recoveryThreshold: 3,
        windowMs: 15 * 60_000,
        cooldownMs: 60 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    // Four failures with attemptCount well below the threshold:
    // shouldn't trip the count-based OR the single-event tripwire.
    for (let i = 1; i <= 4; i++) {
      totpAuthAlerter.recordLoginFailure(42, i);
    }
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);

    totpAuthAlerter.recordLoginFailure(42, 5);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/userId=42/);
    expect(sent[0].text).toMatch(/5 verify failures/);
    expect(sent[0].text).toMatch(/peak attemptCount=5/);
    expect(sent[0].text).toMatch(/15m/);
  });

  it('fires immediately on a single failure whose attemptCount already exceeds the threshold', async () => {
    // Real scenario: a stolen pending cookie is being walked. The
    // route bumps attemptCount per request, but if the alerter is
    // initialized mid-attack (or a separate node sees its first
    // event from this user) one log line should be enough to alert
    // — we don't need to wait for N more requests.
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 5,
        recoveryThreshold: 3,
        windowMs: 15 * 60_000,
        cooldownMs: 60 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    totpAuthAlerter.recordLoginFailure(7, 6);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/userId=7/);
    expect(sent[0].text).toMatch(/peak attemptCount=6/);
  });

  it('counts and cools down independently per account', async () => {
    // Per-account isolation matters most under a coordinated multi-
    // account attack: a single global cooldown would silence every
    // alert past the first, which is the case where on-call most
    // needs to see them.
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 3,
        recoveryThreshold: 3,
        windowMs: 15 * 60_000,
        cooldownMs: 60 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    // User A trips the alert.
    for (let i = 1; i <= 3; i++) totpAuthAlerter.recordLoginFailure(1, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/userId=1/);

    // User A within cooldown — additional events do not refire.
    now += 60_000;
    for (let i = 4; i <= 6; i++) totpAuthAlerter.recordLoginFailure(1, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // User B should fire on its own — same wall clock, separate
    // per-account cooldown.
    for (let i = 1; i <= 3; i++) totpAuthAlerter.recordLoginFailure(2, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/userId=2/);
  });

  it('honors per-account failure cooldown and refires after it elapses', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 3,
        recoveryThreshold: 3,
        windowMs: 5 * 60_000,
        cooldownMs: 10 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    for (let i = 1; i <= 3; i++) totpAuthAlerter.recordLoginFailure(11, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // Within cooldown — events do not refire.
    now += 3 * 60_000;
    for (let i = 4; i <= 6; i++) totpAuthAlerter.recordLoginFailure(11, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // Past the cooldown — window has rolled over so we need 3 fresh
    // events to cross the threshold again.
    now += 12 * 60_000;
    for (let i = 1; i <= 3; i++) totpAuthAlerter.recordLoginFailure(11, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
  });

  it('drops failure events older than the window before evaluating the threshold', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 3,
        recoveryThreshold: 3,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    // Two failures with low attemptCount — won't fire on their own.
    totpAuthAlerter.recordLoginFailure(99, 1);
    totpAuthAlerter.recordLoginFailure(99, 2);
    now += 90_000;

    // A third failure now should NOT fire — the first two have aged
    // out, and attemptCount=2 doesn't trip the single-event tripwire.
    totpAuthAlerter.recordLoginFailure(99, 2);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('fires recovery_code_used burst on a single account once threshold is crossed', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 5,
        recoveryThreshold: 3,
        windowMs: 15 * 60_000,
        cooldownMs: 60 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    totpAuthAlerter.recordRecoveryCodeUsed(55);
    totpAuthAlerter.recordRecoveryCodeUsed(55);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);

    totpAuthAlerter.recordRecoveryCodeUsed(55);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/userId=55/);
    expect(sent[0].text).toMatch(/3 codes consumed/);
    expect(sent[0].text).toMatch(/recovery/i);
  });

  it('failure-channel cooldown does not silence the recovery channel on the same account', async () => {
    // Failure and recovery alerts are independently triggered and
    // independently cooled down — a brute-force burst should not
    // mask a separate compromise signal on the same user.
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 3,
        recoveryThreshold: 2,
        windowMs: 15 * 60_000,
        cooldownMs: 60 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    for (let i = 1; i <= 3; i++) totpAuthAlerter.recordLoginFailure(77, i);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/brute force/i);

    // Same account, still inside the failure cooldown — recovery
    // alert must still fire.
    totpAuthAlerter.recordRecoveryCodeUsed(77);
    totpAuthAlerter.recordRecoveryCodeUsed(77);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/recovery/i);
    expect(sent[1].text).toMatch(/userId=77/);
  });

  it('drops recovery events older than the window', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 5,
        recoveryThreshold: 3,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    totpAuthAlerter.recordRecoveryCodeUsed(88);
    totpAuthAlerter.recordRecoveryCodeUsed(88);
    now += 90_000;

    totpAuthAlerter.recordRecoveryCodeUsed(88);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('is a silent no-op when no webhook URL and no notifier are set', () => {
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: null,
        failureThreshold: 1,
        recoveryThreshold: 1,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: null,
      now: () => now,
    });
    // The contract is "off by default in dev / fresh deploys"; this
    // test pins that no exception, no fetch, no crash come out of
    // the silent path even when the threshold trips on every call.
    totpAuthAlerter.recordLoginFailure(1, 99);
    totpAuthAlerter.recordRecoveryCodeUsed(1);
  });

  it('garbage-collects per-account map entries once their windows age out', async () => {
    // The per-account event maps are keyed by userId; without GC,
    // every distinct userId that ever produced a single failure
    // would leave an empty array in the map for the lifetime of
    // the process. This test pins that map cardinality stays
    // bounded under load with many one-off events across many
    // distinct accounts.
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 5,
        recoveryThreshold: 3,
        windowMs: 60_000,
        cooldownMs: 5 * 60_000,
      },
      notifier: async () => {},
      now: () => now,
    });

    // 50 distinct accounts each emit a single sub-threshold failure
    // and a single recovery use. Map sizes grow as we go.
    for (let u = 1; u <= 50; u++) {
      totpAuthAlerter.recordLoginFailure(u, 1);
      totpAuthAlerter.recordRecoveryCodeUsed(u);
    }
    expect(totpAuthAlerter._debugSizes().failures).toBe(50);
    expect(totpAuthAlerter._debugSizes().recoveries).toBe(50);

    // Roll the clock past the window. The next record() (on a
    // single new user) sweeps every other key whose array has aged
    // out, leaving only the actively-recording user behind.
    now += 90_000;
    totpAuthAlerter.recordLoginFailure(999, 1);
    totpAuthAlerter.recordRecoveryCodeUsed(999);
    expect(totpAuthAlerter._debugSizes().failures).toBe(1);
    expect(totpAuthAlerter._debugSizes().recoveries).toBe(1);
  });

  it('tolerates missing/null attemptCount on failure events', () => {
    // ctx.attemptCount is optional on TotpAuditContext (the public
    // interface allows undefined). The alerter degrades to count-only
    // tripwires in that case rather than throwing.
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    totpAuthAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        failureThreshold: 3,
        recoveryThreshold: 3,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    totpAuthAlerter.recordLoginFailure(123, undefined);
    totpAuthAlerter.recordLoginFailure(123, null);
    totpAuthAlerter.recordLoginFailure(123, undefined);
    return new Promise<void>((r) => setImmediate(r)).then(() => {
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/peak attemptCount=0/);
    });
  });
});
