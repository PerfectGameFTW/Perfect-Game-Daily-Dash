import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logShipper } from '../services/logShipper';

// These tests drive the shipper directly via its test hooks rather
// than going through the structured logger, so a flush failure here
// can't affect any other test in the suite (the hook into
// `server/logger.ts` is left untouched — we only verify the shipper
// behavior in isolation).

interface SentBatch {
  url: string;
  body: unknown;
  token: string | null;
}

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    prior[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k]!;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(prior)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k]!;
    }
  });
}

describe('logShipper', () => {
  beforeEach(() => {
    logShipper.resetForTesting();
  });
  afterEach(() => {
    logShipper.resetForTesting();
  });

  it('is a no-op when LOG_SHIPPER_URL is unset', async () => {
    await withEnv({ LOG_SHIPPER_URL: undefined }, async () => {
      const sent: SentBatch[] = [];
      logShipper.setSenderForTesting(async (url, body, token) => {
        sent.push({ url, body: JSON.parse(body), token });
        return { ok: true, status: 200 };
      });
      logShipper.start();
      expect(logShipper.isActive()).toBe(false);
      logShipper.enqueue({ ts: 't', level: 'info', msg: 'should be dropped' });
      await logShipper.flush();
      expect(sent).toHaveLength(0);
    });
  });

  it('flushes a batch when batchSize is reached', async () => {
    await withEnv({
      LOG_SHIPPER_URL: 'https://example.invalid/in',
      LOG_SHIPPER_TOKEN: 'tok-123',
      LOG_SHIPPER_BATCH_SIZE: '3',
      LOG_SHIPPER_FLUSH_MS: '60000',
    }, async () => {
      const sent: SentBatch[] = [];
      logShipper.setSenderForTesting(async (url, body, token) => {
        sent.push({ url, body: JSON.parse(body), token });
        return { ok: true, status: 202 };
      });
      logShipper.start();
      expect(logShipper.isActive()).toBe(true);

      logShipper.enqueue({ ts: 't1', level: 'info', msg: 'a' });
      logShipper.enqueue({ ts: 't2', level: 'info', msg: 'b' });
      // Threshold not reached yet.
      await new Promise((r) => setImmediate(r));
      expect(sent).toHaveLength(0);

      logShipper.enqueue({ ts: 't3', level: 'info', msg: 'c' });
      // The batch flush is fire-and-forget; await microtasks until
      // the sender ran.
      for (let i = 0; i < 10 && sent.length === 0; i++) {
        await new Promise((r) => setImmediate(r));
      }
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe('https://example.invalid/in');
      expect(sent[0].token).toBe('tok-123');
      expect(Array.isArray(sent[0].body)).toBe(true);
      expect((sent[0].body as unknown[]).length).toBe(3);
    });
  });

  it('drops the oldest entry when the buffer is full', async () => {
    await withEnv({
      LOG_SHIPPER_URL: 'https://example.invalid/in',
      LOG_SHIPPER_BATCH_SIZE: '1000',  // never auto-flush in this test
      LOG_SHIPPER_FLUSH_MS: '60000',
      LOG_SHIPPER_BUFFER_MAX: '3',
    }, async () => {
      const sent: SentBatch[] = [];
      logShipper.setSenderForTesting(async (url, body, token) => {
        sent.push({ url, body: JSON.parse(body), token });
        return { ok: true, status: 200 };
      });
      logShipper.start();

      logShipper.enqueue({ ts: '1', msg: 'a' });
      logShipper.enqueue({ ts: '2', msg: 'b' });
      logShipper.enqueue({ ts: '3', msg: 'c' });
      logShipper.enqueue({ ts: '4', msg: 'd' });  // evicts 'a'
      logShipper.enqueue({ ts: '5', msg: 'e' });  // evicts 'b'

      await logShipper.flush();
      expect(sent).toHaveLength(1);
      const msgs = (sent[0].body as Array<{ msg: string }>).map((x) => x.msg);
      expect(msgs).toEqual(['c', 'd', 'e']);
    });
  });

  it('survives a sender that throws and keeps going on the next flush', async () => {
    await withEnv({
      LOG_SHIPPER_URL: 'https://example.invalid/in',
      LOG_SHIPPER_BATCH_SIZE: '100',
      LOG_SHIPPER_FLUSH_MS: '60000',
    }, async () => {
      let calls = 0;
      const sent: SentBatch[] = [];
      logShipper.setSenderForTesting(async (url, body, token) => {
        calls += 1;
        if (calls === 1) throw new Error('network down');
        sent.push({ url, body: JSON.parse(body), token });
        return { ok: true, status: 200 };
      });
      logShipper.start();

      logShipper.enqueue({ msg: 'first' });
      await logShipper.flush();  // throws internally, batch is dropped
      expect(sent).toHaveLength(0);

      logShipper.enqueue({ msg: 'second' });
      await logShipper.flush();
      expect(sent).toHaveLength(1);
      expect((sent[0].body as Array<{ msg: string }>)[0].msg).toBe('second');
    });
  });

  it('drain() flushes multiple pending batches before exiting', async () => {
    await withEnv({
      LOG_SHIPPER_URL: 'https://example.invalid/in',
      LOG_SHIPPER_BATCH_SIZE: '2',
      LOG_SHIPPER_FLUSH_MS: '60000',
    }, async () => {
      const sent: SentBatch[] = [];
      logShipper.setSenderForTesting(async (url, body, token) => {
        sent.push({ url, body: JSON.parse(body), token });
        return { ok: true, status: 200 };
      });
      logShipper.start();

      // Five entries with batchSize=2 → expect at least 3 batches
      // delivered before drain returns.
      logShipper.enqueue({ msg: 'a' });
      logShipper.enqueue({ msg: 'b' });
      logShipper.enqueue({ msg: 'c' });
      logShipper.enqueue({ msg: 'd' });
      logShipper.enqueue({ msg: 'e' });
      await logShipper.drain();

      const allMsgs = sent.flatMap((s) => (s.body as Array<{ msg: string }>).map((x) => x.msg));
      expect(allMsgs).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  it('drain() flushes pending entries on shutdown', async () => {
    await withEnv({
      LOG_SHIPPER_URL: 'https://example.invalid/in',
      LOG_SHIPPER_BATCH_SIZE: '100',
      LOG_SHIPPER_FLUSH_MS: '60000',
    }, async () => {
      const sent: SentBatch[] = [];
      logShipper.setSenderForTesting(async (url, body, token) => {
        sent.push({ url, body: JSON.parse(body), token });
        return { ok: true, status: 200 };
      });
      logShipper.start();

      logShipper.enqueue({ msg: 'pre-shutdown-1' });
      logShipper.enqueue({ msg: 'pre-shutdown-2' });
      await logShipper.drain();

      expect(sent).toHaveLength(1);
      expect((sent[0].body as unknown[]).length).toBe(2);
    });
  });
});
