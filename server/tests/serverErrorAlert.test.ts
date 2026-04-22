import { describe, it, expect, beforeEach } from 'vitest';
import { serverErrorAlerter } from '../services/serverErrorAlert';

describe('serverErrorAlerter', () => {
  beforeEach(() => {
    serverErrorAlerter.reset();
  });

  it('fires once threshold is reached within the window', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    serverErrorAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        threshold: 3,
        windowMs: 60_000,
        cooldownMs: 60_000,
      },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    serverErrorAlerter.record('/api/orders', 500);
    serverErrorAlerter.record('/api/orders', 500);
    expect(sent).toHaveLength(0);

    serverErrorAlerter.record('/api/payments', 502);
    // Notifier is fire-and-forget; let microtasks run.
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('/api/orders=2');
    expect(sent[0].text).toContain('/api/payments=1');
  });

  it('honors cooldown and re-fires once the cooldown elapses', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    serverErrorAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        threshold: 2,
        windowMs: 5 * 60_000,
        cooldownMs: 10 * 60_000,
      },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    serverErrorAlerter.record('/api/x', 500);
    serverErrorAlerter.record('/api/x', 500);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // Still within cooldown — additional events do not refire.
    now += 3 * 60_000;
    serverErrorAlerter.record('/api/x', 500);
    serverErrorAlerter.record('/api/x', 500);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);

    // Past the cooldown — next breach should fire again.
    now += 12 * 60_000;
    // The window is 5min so old events have already aged out; need 2
    // fresh events to cross the threshold.
    serverErrorAlerter.record('/api/x', 500);
    serverErrorAlerter.record('/api/x', 500);
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(2);
  });

  it('is a silent no-op when no webhook URL and no notifier are set', () => {
    let now = 1_000_000;
    serverErrorAlerter.reconfigure({
      config: { webhookUrl: null, threshold: 1, windowMs: 60_000, cooldownMs: 60_000 },
      notifier: null,
      now: () => now,
    });
    // Must not throw.
    serverErrorAlerter.record('/api/x', 500);
    serverErrorAlerter.record('/api/x', 503);
  });

  it('evicts events older than the window', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    serverErrorAlerter.reconfigure({
      config: {
        webhookUrl: 'https://example/hook',
        threshold: 3,
        windowMs: 60_000,
        cooldownMs: 1,
      },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    serverErrorAlerter.record('/api/x', 500);
    serverErrorAlerter.record('/api/x', 500);
    // Advance past the window so the first two age out.
    now += 120_000;
    serverErrorAlerter.record('/api/x', 500);
    serverErrorAlerter.record('/api/x', 500);
    await new Promise((r) => setImmediate(r));
    // Only 2 events in the current window — below threshold of 3.
    expect(sent).toHaveLength(0);
  });
});
