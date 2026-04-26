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

  // Pure-read snapshot used by the admin "Alerter live state" panel
  // (Task #121). Critical invariants: the call must NEVER mutate the
  // rolling buffer (otherwise a polling admin page would silently
  // alter live alerter behaviour) and it must filter the count and
  // breakdown to the *current* effective window — not just return
  // whatever happens to still be in the array from past `record()`s.
  describe('getRuntimeState() snapshot for admin UI (Task #121)', () => {
    it('reports zero count and no alert before any 429 has been recorded', () => {
      squareRateLimitAlerter.reconfigure({
        config: { webhookUrl: 'https://example/hook', threshold: 3, windowMs: 60_000, cooldownMs: 60_000 },
        notifier: async () => {},
        now: () => 1_000_000,
      });

      const s = squareRateLimitAlerter.getRuntimeState();
      expect(s.eventCount).toBe(0);
      expect(s.breakdown).toEqual([]);
      expect(s.lastAlertAt).toBeNull();
      expect(s.cooldownRemainingMs).toBe(0);
      expect(s.episodeActive).toBe(false);
      expect(s.webhookConfigured).toBe(true);
      expect(s.windowMs).toBe(60_000);
      expect(s.now).toBe(1_000_000);
    });

    it('counts only events inside the rolling window and returns a sorted breakdown', () => {
      let now = 1_000_000;
      squareRateLimitAlerter.reconfigure({
        config: { webhookUrl: 'https://example/hook', threshold: 100, windowMs: 60_000, cooldownMs: 60_000 },
        notifier: async () => {},
        now: () => now,
      });

      // 2× orders, 1× payments, all inside the window.
      squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
      squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
      squareRateLimitAlerter.record('historical_sync', 'fetchPayments');

      // Advance past the window — older events should drop OUT of
      // the snapshot count even though `record()` hasn't run yet to
      // compact them. This is the regression guard against a future
      // change that returns `this.events.length` directly.
      now = 1_000_000 + 90_000;

      const s = squareRateLimitAlerter.getRuntimeState();
      expect(s.eventCount).toBe(0);
      expect(s.breakdown).toEqual([]);

      // Re-record inside a fresh window and check the sort: orders
      // (2) should sort before payments (1).
      squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
      squareRateLimitAlerter.record('historical_sync', 'fetchOrders');
      squareRateLimitAlerter.record('historical_sync', 'fetchPayments');

      const s2 = squareRateLimitAlerter.getRuntimeState();
      expect(s2.eventCount).toBe(3);
      expect(s2.breakdown).toEqual([
        { key: 'historical_sync/fetchOrders', count: 2 },
        { key: 'historical_sync/fetchPayments', count: 1 },
      ]);
    });

    it('reports lastAlertAt and remaining cooldown after an alert fires', () => {
      let now = 0;
      squareRateLimitAlerter.reconfigure({
        config: { webhookUrl: 'https://example/hook', threshold: 1, windowMs: 60_000, cooldownMs: 30_000 },
        notifier: async () => {},
        now: () => now,
      });

      squareRateLimitAlerter.record('a', 'b'); // alert fires at t=0
      const s1 = squareRateLimitAlerter.getRuntimeState();
      expect(s1.lastAlertAt).toBe(0);
      expect(s1.cooldownRemainingMs).toBe(30_000);
      expect(s1.episodeActive).toBe(true);

      now = 25_000;
      const s2 = squareRateLimitAlerter.getRuntimeState();
      expect(s2.cooldownRemainingMs).toBe(5_000);

      // Past cooldown — clamps at 0, doesn't go negative.
      now = 31_000;
      const s3 = squareRateLimitAlerter.getRuntimeState();
      expect(s3.cooldownRemainingMs).toBe(0);
      expect(s3.lastAlertAt).toBe(0); // history preserved
    });

    it('is a pure read — calling it does not advance, evict, or compact the rolling buffer', () => {
      // The contract is critical: the admin panel polls every few
      // seconds, and if `getRuntimeState()` mutated state then the
      // alerter's behaviour would silently depend on whether anyone
      // is watching. Verify by recording an event, snapshotting many
      // times, and asserting the event still fires the threshold
      // alert exactly when expected.
      let now = 0;
      const sent: Array<{ text: string }> = [];
      squareRateLimitAlerter.reconfigure({
        config: { webhookUrl: 'https://example/hook', threshold: 2, windowMs: 60_000, cooldownMs: 60_000 },
        notifier: async (p) => { sent.push(p); },
        now: () => now,
      });

      squareRateLimitAlerter.record('x', 'y');
      // Snapshot many times — must not consume the buffered event.
      for (let i = 0; i < 10; i++) {
        const s = squareRateLimitAlerter.getRuntimeState();
        expect(s.eventCount).toBe(1);
      }
      expect(sent).toHaveLength(0);

      // Second event should still trip the threshold even after all
      // those snapshots.
      squareRateLimitAlerter.record('x', 'y');
      expect(sent).toHaveLength(1);
      const after = squareRateLimitAlerter.getRuntimeState();
      expect(after.eventCount).toBe(2);
      expect(after.lastAlertAt).toBe(0);
      expect(after.episodeActive).toBe(true);
    });

    it('reports webhookConfigured=false when neither a webhook URL nor a notifier is set', () => {
      squareRateLimitAlerter.reconfigure({
        config: { webhookUrl: null, threshold: 1, windowMs: 60_000, cooldownMs: 60_000 },
        notifier: null,
        now: () => 5_000,
      });
      const s = squareRateLimitAlerter.getRuntimeState();
      expect(s.webhookConfigured).toBe(false);
      expect(s.episodeActive).toBe(false);
      expect(s.lastAlertAt).toBeNull();
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
