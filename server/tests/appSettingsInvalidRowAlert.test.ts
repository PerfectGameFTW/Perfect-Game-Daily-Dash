/**
 * Unit tests for the in-process app_settings invalid-row alerter
 * (Task #122). Mirrors the test patterns in
 * `squareRateLimitAlert.test.ts` / `serverErrorAlert.test.ts`:
 * inject a notifier + clock so we can drive the cooldown
 * deterministically without real timers or outbound HTTP.
 *
 * Vitest's default forks pool isolates module state per file, so the
 * process-global alerter mutated here does not bleed into the
 * pgStorage integration test that exercises the same alerter via
 * the storage layer.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  appSettingsInvalidRowAlerter,
  recordAppSettingsInvalidRowForAlerting,
  recordAppSettingsRecoveryForAlerting,
} from '../services/appSettingsInvalidRowAlert';

const ISSUE_A = [{ path: 'threshold', message: 'Expected number, received string' }];
const ISSUE_B = [{ path: 'enabled', message: 'Required' }];

describe('appSettingsInvalidRowAlerter (Task #122)', () => {
  beforeEach(() => {
    appSettingsInvalidRowAlerter.reset();
  });

  it('fires a webhook the first time a key fails validation', () => {
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => 1_000,
    });

    appSettingsInvalidRowAlerter.record('squareRateLimitAlertSettings', ISSUE_A);
    expect(sent).toHaveLength(1);
    // Payload contract: must name the offending key AND surface the
    // validation issues so the on-call responder can identify the
    // exact row to fix without grepping logs first.
    expect(sent[0].text).toContain('squareRateLimitAlertSettings');
    expect(sent[0].text).toContain('threshold');
    expect(sent[0].text).toContain('Expected number, received string');
    // The runbook hint must be in the alert payload itself —
    // operators read alert text, not surrounding logs.
    expect(sent[0].text).toMatch(/migration/i);
    expect(sent[0].text).toMatch(/never hand-edit/i);
  });

  it('suppresses repeat alerts for the same key while inside the cooldown', () => {
    const sent: Array<{ text: string }> = [];
    let now = 0;
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);

    // Same key polled many times during the cooldown — the whole point
    // of having a cooldown is so a row that's broken on every request
    // doesn't page on-call hundreds of times before they can deploy
    // a fix.
    for (let i = 0; i < 50; i++) {
      now = 30_000 + i * 10;
      appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    }
    expect(sent).toHaveLength(1);
  });

  it('fires again for the same key once the cooldown elapses', () => {
    const sent: Array<{ text: string }> = [];
    let now = 0;
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);

    now = 70_000;
    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(2);
  });

  it('tracks cooldowns per key independently — a different broken key alerts immediately', () => {
    // Critical for production: if both `squareRateLimitAlertSettings`
    // and `requireAdmin2FA` go bad simultaneously, on-call must hear
    // about both, not just whichever was logged first.
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60 * 60 * 1000 },
      notifier: async (p) => { sent.push(p); },
      now: () => 0,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    appSettingsInvalidRowAlerter.record('keyB', ISSUE_B);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain('keyA');
    expect(sent[1].text).toContain('keyB');

    // keyA inside its own cooldown — still suppressed.
    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(2);
  });

  it('is a silent no-op when no webhook URL or notifier is configured', () => {
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: null, cooldownMs: 60_000 },
      notifier: null,
    });
    expect(() =>
      appSettingsInvalidRowAlerter.record('keyA', ISSUE_A),
    ).not.toThrow();
    // Critically: the cooldown timestamp must NOT be set when nothing
    // was sent. Otherwise enabling the webhook later would suppress
    // the very first real alert until the cooldown elapses.
    appSettingsInvalidRowAlerter.reconfigure({
      notifier: async () => {},
    });
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      notifier: async (p) => { sent.push(p); },
    });
    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);
  });

  it('caps the issues list inside the alert text so a pathological schema cannot blow up the post', () => {
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => 0,
    });

    const manyIssues = Array.from({ length: 20 }, (_, i) => ({
      path: `field${i}`,
      message: `issue${i}`,
    }));
    appSettingsInvalidRowAlerter.record('keyA', manyIssues);

    expect(sent).toHaveLength(1);
    // First 5 issues shown verbatim, the rest summarised — keeps the
    // Slack post readable and well under any provider's 4 KB limit.
    expect(sent[0].text).toContain('field0');
    expect(sent[0].text).toContain('field4');
    expect(sent[0].text).not.toContain('field5');
    expect(sent[0].text).toMatch(/15 more/);
  });

  it('the public hook delegates to the singleton alerter', () => {
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
    });

    recordAppSettingsInvalidRowForAlerting('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('keyA');
  });

  // -- Task #168: row-recovered signal -----------------------------

  it('clears the per-key cooldown on recovery so the next break re-alerts immediately', () => {
    // The exact failure mode the task targets: an admin ships a fix
    // while the cooldown is still active. Without recovery handling,
    // a subsequent re-break of the same key during the original
    // window would be silently swallowed.
    const sent: Array<{ text: string }> = [];
    let now = 0;
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60 * 60 * 1000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/failed schema validation/);

    // Admin ships the fix-up migration; the very next read succeeds.
    now = 5 * 60_000;
    appSettingsInvalidRowAlerter.recordRecovery('keyA');
    // Recovery sends its own "all-clear" ping per the task's
    // optional follow-on so on-call hears the row is healthy.
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/keyA/);
    expect(sent[1].text).toMatch(/passes schema validation again/);
    expect(appSettingsInvalidRowAlerter.hasCooldownFor('keyA')).toBe(false);

    // Schema flips again 10 minutes later — *inside* the original
    // hour-long cooldown. The whole point of recovery handling is
    // that this re-alerts immediately rather than waiting out the
    // stale window.
    now = 15 * 60_000;
    appSettingsInvalidRowAlerter.record('keyA', ISSUE_B);
    expect(sent).toHaveLength(3);
    expect(sent[2].text).toMatch(/failed schema validation/);
    expect(sent[2].text).toMatch(/enabled/);
  });

  it('is a no-op when recording recovery for a key that never alerted', () => {
    // Healthy keys read on every request — the recovery hook fires
    // for each one of those reads. Sending an "all-clear" without a
    // prior alert would page on-call about something that was
    // never a problem.
    const sent: Array<{ text: string }> = [];
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => 0,
    });

    appSettingsInvalidRowAlerter.recordRecovery('healthyKey');
    expect(sent).toHaveLength(0);
    expect(appSettingsInvalidRowAlerter.hasCooldownFor('healthyKey')).toBe(false);
  });

  it('recovery only clears the cooldown for the specific key that recovered', () => {
    // Two unrelated keys break together. Healing one must NOT
    // re-arm the other's cooldown — the still-broken key should
    // continue to be suppressed by its own (unchanged) timer until
    // it itself recovers.
    const sent: Array<{ text: string }> = [];
    let now = 0;
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60 * 60 * 1000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    appSettingsInvalidRowAlerter.record('keyB', ISSUE_B);
    expect(sent).toHaveLength(2);

    now = 5 * 60_000;
    appSettingsInvalidRowAlerter.recordRecovery('keyA');
    expect(appSettingsInvalidRowAlerter.hasCooldownFor('keyA')).toBe(false);
    expect(appSettingsInvalidRowAlerter.hasCooldownFor('keyB')).toBe(true);

    // keyB still inside its own cooldown — must remain suppressed.
    now = 10 * 60_000;
    appSettingsInvalidRowAlerter.record('keyB', ISSUE_B);
    // sent grew by one (the recovery ping for keyA) but no new
    // break-alert for keyB.
    expect(sent.filter((s) => s.text.includes('failed schema validation') && s.text.includes('keyB'))).toHaveLength(1);
  });

  it('recovery is silent when no webhook or notifier is configured but still clears the cooldown', () => {
    // The "log-only" deployment posture: an operator wants the
    // cooldown semantics fixed but hasn't wired up Slack yet.
    // Critically, a webhook configured *after* the recovery must
    // alert on the next genuine break — the cooldown must not
    // linger just because nothing was sent.
    const sent: Array<{ text: string }> = [];
    let now = 0;
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60 * 60 * 1000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);

    // Drop the webhook (simulates operator unsetting the env / the
    // alerter being constructed without one) before recovery fires.
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: null },
      notifier: null,
    });

    now = 5 * 60_000;
    appSettingsInvalidRowAlerter.recordRecovery('keyA');
    expect(sent).toHaveLength(1); // no recovery ping
    expect(appSettingsInvalidRowAlerter.hasCooldownFor('keyA')).toBe(false);

    // Re-attach a notifier — a new break alerts immediately
    // because the cooldown was cleared even with no webhook.
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook' },
      notifier: async (p) => { sent.push(p); },
    });
    now = 10 * 60_000;
    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(2);
  });

  it('the public recovery hook delegates to the singleton alerter', () => {
    const sent: Array<{ text: string }> = [];
    let now = 0;
    appSettingsInvalidRowAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    appSettingsInvalidRowAlerter.record('keyA', ISSUE_A);
    expect(sent).toHaveLength(1);
    now = 1_000;
    recordAppSettingsRecoveryForAlerting('keyA');
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/passes schema validation again/);
  });
});
