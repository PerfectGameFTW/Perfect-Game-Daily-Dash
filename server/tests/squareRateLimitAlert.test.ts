import { describe, it, expect, beforeEach } from 'vitest';
import { squareRateLimitAlerter } from '../services/squareRateLimitAlert';
import { logIfSquare429 } from '../services/syncLocks';

describe('squareRateLimitAlerter', () => {
  beforeEach(() => {
    squareRateLimitAlerter.reset();
  });

  it('fires the webhook once the threshold is hit within the window', async () => {
    const sent: Array<{ text: string }> = [];
    let now = 1_000_000;
    squareRateLimitAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', threshold: 3, windowMs: 60_000, cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
    squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
    expect(sent).toHaveLength(0);

    squareRateLimitAlerter.record('historical_sync', 'fetchPayments');
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('historical_sync/fetchOrders=2');
    expect(sent[0].text).toContain('historical_sync/fetchPayments=1');
  });

  it('does not refire while in cooldown but fires again after cooldown', () => {
    const sent: Array<{ text: string }> = [];
    let now = 0;
    squareRateLimitAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', threshold: 1, windowMs: 60_000, cooldownMs: 10_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    squareRateLimitAlerter.record('a', 'b');
    expect(sent).toHaveLength(1);

    now = 5_000;
    squareRateLimitAlerter.record('a', 'b');
    expect(sent).toHaveLength(1); // still in cooldown

    now = 20_000;
    squareRateLimitAlerter.record('a', 'b');
    expect(sent).toHaveLength(2);
  });

  it('drops events older than the window from the rolling count', () => {
    const sent: Array<{ text: string }> = [];
    let now = 0;
    squareRateLimitAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', threshold: 3, windowMs: 1_000, cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
      now: () => now,
    });

    squareRateLimitAlerter.record('a', 'b');
    squareRateLimitAlerter.record('a', 'b');
    now = 2_000; // old events evicted
    squareRateLimitAlerter.record('a', 'b');
    expect(sent).toHaveLength(0);
  });

  it('does nothing if no webhook URL or notifier is configured', () => {
    squareRateLimitAlerter.reconfigure({
      config: { webhookUrl: null, threshold: 1, windowMs: 1_000, cooldownMs: 1_000 },
      notifier: null,
    });
    expect(() => squareRateLimitAlerter.record('a', 'b')).not.toThrow();
  });

  it('logIfSquare429 feeds the alerter on 429 errors', () => {
    const sent: Array<{ text: string }> = [];
    squareRateLimitAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', threshold: 1, windowMs: 60_000, cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
    });

    const handled = logIfSquare429(
      { statusCode: 429, message: 'Too Many Requests' },
      { syncType: 'historical_sync', source: 'fetchOrders' },
    );
    expect(handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('historical_sync/fetchOrders=1');
  });

  it('logIfSquare429 ignores non-429 errors', () => {
    const sent: Array<{ text: string }> = [];
    squareRateLimitAlerter.reconfigure({
      config: { webhookUrl: 'https://example/hook', threshold: 1, windowMs: 60_000, cooldownMs: 60_000 },
      notifier: async (p) => { sent.push(p); },
    });

    const handled = logIfSquare429(
      { statusCode: 500, message: 'oops' },
      { syncType: 'historical_sync', source: 'fetchOrders' },
    );
    expect(handled).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
