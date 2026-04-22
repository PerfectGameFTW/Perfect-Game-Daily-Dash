/**
 * HTTP log shipper.
 *
 * Buffers structured log lines and forwards them, in batches, to a
 * remote ingest endpoint (Logtail / Better Stack, Axiom, or any
 * Bearer-token-authenticated `POST` that accepts a JSON array of log
 * objects). When the destination env vars are unset (dev / a fresh
 * deploy that hasn't been wired yet), the shipper is a complete no-op
 * — `process.stdout` / `process.stderr` are still the source of truth
 * and nothing changes.
 *
 * Why this is its own module (and not, say, a winston transport):
 *   - The logger contract (`server/logger.ts`) is intentionally tiny
 *     and write-everything-as-JSON; tying it to a specific transport
 *     library would drag in a lot of code path and obscure the
 *     allow-listing guarantee that protects against PII leaks. The
 *     shipper just consumes the same JSON line the logger already
 *     emits.
 *   - The shipper must NEVER call `logger.*` from its own failure
 *     path. Doing so would re-enqueue the failure event and either
 *     deadlock the buffer or amplify outages. Failure paths write a
 *     single JSON line directly to `process.stderr` with the
 *     `log_shipper.*` event names so an operator looking at the
 *     workspace logs (or any other transport that's still working)
 *     can see what went wrong.
 *
 * Design:
 *   - Bounded buffer (default 1000 entries). On overflow the oldest
 *     entry is dropped to make room and a single
 *     `log_shipper.dropped` warning is emitted to stderr per overflow
 *     window — never per-event, so a sustained outage doesn't
 *     amplify itself.
 *   - Batches are flushed when the buffer reaches `batchSize` OR
 *     when `flushIntervalMs` elapses with anything pending.
 *   - Each flush is a single `fetch` POST with a hard timeout
 *     (default 5s). Failed flushes drop the batch — we are NOT a
 *     guaranteed-delivery durable queue; the local stdout JSON line
 *     is the durable record. That keeps memory bounded without an
 *     on-disk WAL.
 *   - On graceful shutdown, `flush()` synchronously writes any
 *     pending batch and resolves once delivery is attempted.
 */

interface LogShipperConfig {
  url: string;
  token: string | null;
  batchSize: number;
  flushIntervalMs: number;
  maxBufferSize: number;
  requestTimeoutMs: number;
}

function intFromEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function loadEnvConfig(): LogShipperConfig | null {
  const url = process.env.LOG_SHIPPER_URL;
  if (!url) return null;
  return {
    url,
    token: process.env.LOG_SHIPPER_TOKEN || null,
    batchSize: intFromEnv('LOG_SHIPPER_BATCH_SIZE', 50),
    flushIntervalMs: intFromEnv('LOG_SHIPPER_FLUSH_MS', 2000, 100),
    maxBufferSize: intFromEnv('LOG_SHIPPER_BUFFER_MAX', 1000),
    requestTimeoutMs: intFromEnv('LOG_SHIPPER_REQUEST_TIMEOUT_MS', 5000, 100),
  };
}

/**
 * Stderr-only logger for the shipper's own lifecycle / failure
 * messages. Bypasses `server/logger.ts` so a shipper failure can
 * never re-enqueue itself.
 */
function emitShipperEvent(level: 'warn' | 'error' | 'info', msg: string, ctx: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  }) + '\n';
  process.stderr.write(line);
}

type Sender = (
  url: string,
  body: string,
  token: string | null,
  timeoutMs: number,
) => Promise<{ ok: boolean; status: number }>;

const defaultSender: Sender = async (url, body, token, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
};

class LogShipper {
  private buffer: Record<string, unknown>[] = [];
  private config: LogShipperConfig | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private droppedSinceLastWarn = 0;
  private sender: Sender = defaultSender;
  // Set once start() is called so enqueue() is cheap to short-circuit
  // when shipping is off.
  private active = false;

  /**
   * Start (or restart) the shipper. Reads env config; no-op if
   * `LOG_SHIPPER_URL` is not set. Safe to call multiple times — a
   * second call replaces the existing config and timer.
   */
  start(): void {
    const cfg = loadEnvConfig();
    if (!cfg) {
      // Env-off path: if a prior call activated the shipper but the
      // env was subsequently cleared (e.g. dynamic reconfig in tests),
      // tear the timer down so we are a true no-op rather than
      // leaking the interval against a stale config.
      this.stop();
      this.config = null;
      this.active = false;
      return;
    }
    this.config = cfg;
    this.active = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = setInterval(() => {
      void this.flush().catch(() => { /* swallowed in flush */ });
    }, cfg.flushIntervalMs);
    // Don't keep the event loop alive solely for the flush timer.
    this.flushTimer.unref?.();
    emitShipperEvent('info', 'log_shipper.started', {
      batchSize: cfg.batchSize,
      flushIntervalMs: cfg.flushIntervalMs,
      maxBufferSize: cfg.maxBufferSize,
    });
  }

  /**
   * Test-only: replace the HTTP sender. Must be called before
   * `start()` (or after `stop()`).
   */
  setSenderForTesting(sender: Sender): void {
    this.sender = sender;
  }

  /**
   * Test-only: reset state.
   */
  resetForTesting(): void {
    this.stop();
    this.buffer = [];
    this.config = null;
    this.inFlight = false;
    this.droppedSinceLastWarn = 0;
    this.sender = defaultSender;
    this.active = false;
  }

  /** Returns true when shipping is on. Cheap predicate for callers. */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Enqueue one log line. Called by the structured logger after every
   * `emit()`. Hot path — must be O(1) and never throw.
   */
  enqueue(line: Record<string, unknown>): void {
    if (!this.active || !this.config) return;
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.buffer.shift();
      this.droppedSinceLastWarn += 1;
      // Throttle the warning to once per ~30s so a sustained outage
      // doesn't itself flood stderr.
      if (this.droppedSinceLastWarn === 1 || this.droppedSinceLastWarn % 1000 === 0) {
        emitShipperEvent('warn', 'log_shipper.dropped', {
          count: this.droppedSinceLastWarn,
        });
      }
    }
    this.buffer.push(line);
    if (this.buffer.length >= this.config.batchSize) {
      // Don't await — the logger is synchronous and we must not block
      // its callers.
      void this.flush().catch(() => { /* swallowed in flush */ });
    }
  }

  /**
   * Flush whatever is currently buffered. Resolves when the POST
   * settles (success or failure). Concurrent calls are coalesced via
   * `inFlight`.
   */
  async flush(): Promise<void> {
    if (!this.active || !this.config) return;
    if (this.inFlight) return;
    if (this.buffer.length === 0) return;
    this.inFlight = true;
    const cfg = this.config;
    // Take ownership of the current batch up front so concurrent
    // enqueues during the network round-trip end up in the next batch.
    const batch = this.buffer.splice(0, cfg.batchSize);
    try {
      const body = JSON.stringify(batch);
      const result = await this.sender(cfg.url, body, cfg.token, cfg.requestTimeoutMs);
      if (!result.ok) {
        emitShipperEvent('warn', 'log_shipper.flush_failed', {
          status: result.status,
          count: batch.length,
        });
      } else if (this.droppedSinceLastWarn > 0) {
        // Recovery — emit a single line so an operator can see the
        // outage ended and how much was lost in the meantime.
        emitShipperEvent('warn', 'log_shipper.recovered', {
          dropped: this.droppedSinceLastWarn,
        });
        this.droppedSinceLastWarn = 0;
      }
    } catch (err) {
      emitShipperEvent('warn', 'log_shipper.flush_error', {
        errorMessage: err instanceof Error ? err.message : String(err),
        count: batch.length,
      });
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Stop the periodic flush timer. Used in tests and at graceful
   * shutdown after a final `flush()`.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Best-effort drain on graceful shutdown. Loops until either the
   * buffer is empty or the overall deadline is reached, so a buffer
   * holding multiple batches at shutdown is fully flushed (subject to
   * the budget). Bounded by `deadlineMs` so a hung remote can never
   * stall the shutdown sequence past the caller's hard timeout.
   */
  async drain(deadlineMs = 4000): Promise<void> {
    if (!this.active || !this.config) return;
    const start = Date.now();
    const deadline = start + deadlineMs;

    // Wait for any currently in-flight flush to settle so its batch
    // is accounted for before we start emptying what's left.
    while (this.inFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // Drain remaining batches one at a time until empty or budget
    // exhausted. `flush()` self-coalesces via inFlight, so the await
    // here is what gives each batch its turn.
    while (this.buffer.length > 0 && Date.now() < deadline) {
      await this.flush();
      // If a previous call was still in-flight when flush() ran, it
      // returned without doing work — yield and let it settle.
      if (this.inFlight) {
        while (this.inFlight && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    }

    this.stop();
  }
}

export const logShipper = new LogShipper();
