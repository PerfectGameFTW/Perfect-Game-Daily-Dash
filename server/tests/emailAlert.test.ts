/**
 * Tests for the in-process outbound-email failure alerter (Task #104).
 *
 * Mirrors `serverErrorAlert.test.ts` — same shape: rolling window,
 * threshold, cooldown, silent-when-unconfigured. The unique pieces
 * here are reason aggregation (so the alert text tells the operator
 * *which* failure mode is in play) and tighter defaults than the
 * 5xx alerter to reflect that each lost email is one locked-out
 * user.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { emailAlerter } from '../services/emailAlert';

describe('emailAlerter', () => {
  beforeEach(() => {
    emailAlerter.reset();
  });

  it('fires once threshold is reached within the window and aggregates the alert text by reason', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    emailAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        threshold: 3,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    emailAlerter.record('gmail_send_failed_403');
    emailAlerter.record('gmail_send_failed_403');
    expect(sent).toHaveLength(0);

    emailAlerter.record('connector_failed_503');
    // Notifier is fire-and-forget; let microtasks run.
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    // Reason aggregation: the most-common failure mode comes first.
    expect(sent[0].text).toContain('gmail_send_failed_403=2');
    expect(sent[0].text).toContain('connector_failed_503=1');
    // Window is rendered in minutes.
    expect(sent[0].text).toContain('1m');
    // Tag the channel so on-call doesn't confuse this with the 5xx
    // alert from `serverErrorAlert.ts`.
    expect(sent[0].text).toMatch(/email|outbound/i);
  });

  it('honors cooldown and re-fires once the cooldown elapses', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    emailAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        threshold: 2,
        windowMs: 5 * 60_000,
        cooldownMs: 10 * 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    emailAlerter.record('gmail_send_failed_500');
    emailAlerter.record('gmail_send_failed_500');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // Still within cooldown — additional events do not refire.
    now += 3 * 60_000;
    emailAlerter.record('gmail_send_failed_500');
    emailAlerter.record('gmail_send_failed_500');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // Past the cooldown — next breach should fire again. Window is
    // 5min so old events have already aged out; need 2 fresh events
    // to cross the threshold.
    now += 12 * 60_000;
    emailAlerter.record('gmail_send_failed_500');
    emailAlerter.record('gmail_send_failed_500');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
  });

  it('drops events older than the window before evaluating the threshold', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    emailAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        threshold: 3,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: async (p) => {
        sent.push(p);
      },
      now: () => now,
    });

    // Two failures, then move past the window.
    emailAlerter.record('connector_failed');
    emailAlerter.record('connector_failed');
    now += 90_000;

    // A third failure now should NOT fire — the first two have aged
    // out, so the rolling count is only 1.
    emailAlerter.record('connector_failed');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('is a silent no-op when no webhook URL and no notifier are set', () => {
    let now = 1_000_000;
    emailAlerter.reconfigure({
      config: {
        webhookUrl: null,
        threshold: 1,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: null,
      now: () => now,
    });
    // Must not throw — and there's no spy to assert against because
    // there is no I/O. The contract is "off by default in dev / fresh
    // deploys"; this test pins that no exception, no fetch, and no
    // crash come out of the silent path.
    emailAlerter.record('gmail_send_failed_500');
    emailAlerter.record('connector_failed');
  });
});
