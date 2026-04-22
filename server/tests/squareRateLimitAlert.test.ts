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

  describe('recovery / all-clear notification', () => {
    // Tiny manual scheduler: lets the test inspect and fire pending
    // timers synchronously instead of waiting on real wall-clock time.
    interface PendingTimer { dueAt: number; cb: () => void; cancelled: boolean }
    function makeManualScheduler(getNow: () => number) {
      const timers: PendingTimer[] = [];
      const scheduler = (delayMs: number, cb: () => void) => {
        const timer: PendingTimer = { dueAt: getNow() + delayMs, cb, cancelled: false };
        timers.push(timer);
        return () => { timer.cancelled = true; };
      };
      function fireDue(): void {
        // Snapshot then walk: callbacks may schedule new timers.
        const due = timers.filter(t => !t.cancelled && t.dueAt <= getNow());
        for (const t of due) {
          t.cancelled = true;
          t.cb();
        }
      }
      function pendingCount(): number {
        return timers.filter(t => !t.cancelled).length;
      }
      return { scheduler, fireDue, pendingCount };
    }

    it('sends a single recovery message after the window stays quiet for the configured period', () => {
      const sent: Array<{ text: string }> = [];
      let now = 0;
      const sched = makeManualScheduler(() => now);
      squareRateLimitAlerter.reconfigure({
        config: {
          webhookUrl: 'https://example/hook',
          threshold: 1,
          windowMs: 60_000,
          cooldownMs: 60_000,
          recoveryQuietPeriodMs: 30_000,
        },
        notifier: async (p) => { sent.push(p); },
        now: () => now,
        scheduler: sched.scheduler,
      });

      squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain(':rotating_light:');

      // Advance past the quiet period with no further events.
      now = 30_000;
      sched.fireDue();

      expect(sent).toHaveLength(2);
      expect(sent[1].text).toMatch(/recovered/i);
      expect(sent[1].text).toContain(':white_check_mark:');
    });

    it('does not send recovery while 429s keep arriving — watchdog is pushed forward', () => {
      const sent: Array<{ text: string }> = [];
      let now = 0;
      const sched = makeManualScheduler(() => now);
      squareRateLimitAlerter.reconfigure({
        config: {
          webhookUrl: 'https://example/hook',
          threshold: 1,
          windowMs: 60_000,
          cooldownMs: 60_000,
          recoveryQuietPeriodMs: 20_000,
        },
        notifier: async (p) => { sent.push(p); },
        now: () => now,
        scheduler: sched.scheduler,
      });

      squareRateLimitAlerter.record('a', 'b'); // alert fires
      expect(sent).toHaveLength(1);

      // Late-arriving 429 right before the watchdog would fire.
      now = 15_000;
      squareRateLimitAlerter.record('a', 'b');

      now = 25_000; // original watchdog dueAt was 20_000
      sched.fireDue();
      expect(sent).toHaveLength(1); // still no all-clear

      // Now go quiet and let the rescheduled watchdog elapse.
      now = 35_000; // 20_000 after the second event
      sched.fireDue();
      expect(sent).toHaveLength(2);
      expect(sent[1].text).toMatch(/recovered/i);
    });

    it('sends only one recovery per alert episode (no flapping)', () => {
      const sent: Array<{ text: string }> = [];
      let now = 0;
      const sched = makeManualScheduler(() => now);
      squareRateLimitAlerter.reconfigure({
        config: {
          webhookUrl: 'https://example/hook',
          threshold: 1,
          windowMs: 60_000,
          cooldownMs: 60_000,
          recoveryQuietPeriodMs: 10_000,
        },
        notifier: async (p) => { sent.push(p); },
        now: () => now,
        scheduler: sched.scheduler,
      });

      squareRateLimitAlerter.record('a', 'b'); // alert
      now = 10_000;
      sched.fireDue();
      expect(sent.filter(s => /recovered/i.test(s.text))).toHaveLength(1);

      // Firing any leftover timers a second time must not emit another
      // recovery — episode is closed.
      now = 100_000;
      sched.fireDue();
      expect(sent.filter(s => /recovered/i.test(s.text))).toHaveLength(1);
      expect(sched.pendingCount()).toBe(0);
    });

    it('opens a fresh episode (and a fresh recovery) for the next alert after recovery', () => {
      const sent: Array<{ text: string }> = [];
      let now = 0;
      const sched = makeManualScheduler(() => now);
      squareRateLimitAlerter.reconfigure({
        config: {
          webhookUrl: 'https://example/hook',
          threshold: 1,
          windowMs: 60_000,
          cooldownMs: 5_000,
          recoveryQuietPeriodMs: 10_000,
        },
        notifier: async (p) => { sent.push(p); },
        now: () => now,
        scheduler: sched.scheduler,
      });

      squareRateLimitAlerter.record('a', 'b');           // alert #1
      now = 10_000;
      sched.fireDue();                                    // recovery #1
      expect(sent).toHaveLength(2);

      now = 20_000;
      squareRateLimitAlerter.record('a', 'b');           // alert #2
      now = 30_000;
      sched.fireDue();                                    // recovery #2
      expect(sent).toHaveLength(4);
      expect(sent[2].text).toContain(':rotating_light:');
      expect(sent[3].text).toMatch(/recovered/i);
    });

    it('does not send a recovery if the alert never fired (e.g. webhook unconfigured)', () => {
      const sent: Array<{ text: string }> = [];
      let now = 0;
      const sched = makeManualScheduler(() => now);
      squareRateLimitAlerter.reconfigure({
        config: {
          webhookUrl: null,
          threshold: 1,
          windowMs: 60_000,
          cooldownMs: 60_000,
          recoveryQuietPeriodMs: 10_000,
        },
        notifier: null,
        now: () => now,
        scheduler: sched.scheduler,
      });

      squareRateLimitAlerter.record('a', 'b');
      now = 100_000;
      sched.fireDue();
      expect(sent).toHaveLength(0);
      expect(sched.pendingCount()).toBe(0);
    });
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
