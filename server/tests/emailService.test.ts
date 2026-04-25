/**
 * Direct unit tests for the email builder (Task #146).
 *
 * `passwordReset.test.ts` and `emailVerification.test.ts` mock
 * `sendEmail` at the module boundary, so the RFC 5322 assembler,
 * base64url encoding, header-injection guard, missing-token throw, and
 * dev-stub fallback inside `emailService.ts` are not exercised
 * anywhere else in the suite. This file pins those paths directly so a
 * regression in the MIME assembly (missing CRLF, broken multipart
 * boundary, header sanitization bypass, silent prod-drop) fails loudly
 * instead of shipping silently.
 *
 * Strategy: the builder is not exported, so we drive it through
 * `sendEmail` and intercept the outbound `fetch` call to Gmail's
 * `users.messages.send` endpoint. Decoding the captured `raw` field
 * (base64url -> UTF-8) gives us the literal RFC 5322 message bytes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { sendEmail } from '../services/emailService';
import { logger } from '../logger';

interface CapturedSend {
  raw: string;
}

/**
 * base64url -> UTF-8 string. Inverse of the encoder in emailService.
 */
function decodeRaw(raw: string): string {
  const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = padded.length % 4 === 0 ? 0 : 4 - (padded.length % 4);
  return Buffer.from(padded + '='.repeat(padLen), 'base64').toString('utf8');
}

/**
 * Replace global fetch with a mock that:
 *   - answers the connectors-API probe with `token` (or an empty items
 *     array when token is null), and
 *   - records the body of any Gmail send call into `capture.send`.
 *
 * Returns a `restore` to put the original fetch back. We don't rely on
 * vi.restoreAllMocks() so the tear-down ordering is explicit even if a
 * test forgets to await something.
 */
function installFetchMock(token: string | null): {
  capture: { send: CapturedSend | null };
  restore: () => void;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const capture: { send: CapturedSend | null } = { send: null };
  const originalFetch = global.fetch;

  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/v2/connection')) {
      const items = token === null ? [] : [{ settings: { access_token: token } }];
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('gmail.googleapis.com')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { raw: string };
      capture.send = { raw: body.raw };
      return new Response(JSON.stringify({ id: 'mock-msg' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch in emailService.test.ts: ${u}`);
  });

  (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

  return {
    capture,
    fetchMock,
    restore: () => {
      (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    },
  };
}

describe('emailService MIME builder', () => {
  // Snapshot env before every test and restore after — several tests
  // toggle NODE_ENV and the connector env vars.
  let prevEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    prevEnv = { ...process.env };
    // Default: pretend the Replit connector is wired so sendEmail
    // takes the real Gmail-send branch and our fetch mock gets to
    // capture the assembled raw body.
    process.env.REPLIT_CONNECTORS_HOSTNAME = 'connectors.test.invalid';
    process.env.REPL_IDENTITY = 'test-identity';
    delete process.env.WEB_REPL_RENEWAL;
    // Opt out of the NODE_ENV=test safety guard in emailService.ts —
    // these tests exercise the real Gmail branch on purpose with a
    // mocked global.fetch, so no actual network call leaves the
    // process. The guard exists to stop integration suites
    // (passwordReset, emailVerification) from sending real mail to
    // their fixture addresses now that Gmail is wired by default.
    process.env.EMAIL_TEST_ALLOW_REAL_SEND = '1';
  });

  afterEach(() => {
    // Restore env atomically — delete keys added by the test and
    // overwrite the rest with the snapshot.
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k];
    }
    Object.assign(process.env, prevEnv);
    vi.restoreAllMocks();
  });

  it('produces a single-part RFC 5322 body with From / To / Subject / MIME-Version headers for a text-only message', async () => {
    const m = installFetchMock('token-abc');
    try {
      await sendEmail({
        to: 'recipient@example.test',
        subject: 'Hello, world',
        text: 'plain body line 1',
      });

      expect(m.capture.send).not.toBeNull();
      // Pin the encoding contract: Gmail's `raw` field requires
      // base64url (RFC 4648 §5), not standard base64 — `+`, `/`, and
      // `=` padding would all cause the API to reject the message.
      const rawField = m.capture.send!.raw;
      expect(rawField).not.toMatch(/[+/=]/);
      const body = decodeRaw(rawField);

      // Header block / body separator must be CRLF CRLF — a regression
      // that switches to LF would cause Gmail to interpret headers as
      // body content.
      const sepIdx = body.indexOf('\r\n\r\n');
      expect(sepIdx).toBeGreaterThan(0);
      const headerBlock = body.slice(0, sepIdx);
      const bodyPart = body.slice(sepIdx + 4);

      const headers = headerBlock.split('\r\n');
      const findHeader = (name: string): string | undefined =>
        headers.find((h) => h.startsWith(`${name}: `));

      const fromHeader = findHeader('From');
      expect(fromHeader).toBeDefined();
      // From must carry an addr-spec wrapped in <>. We don't pin the
      // exact email/display-name because MAIL_FROM_EMAIL /
      // MAIL_FROM_NAME may be overridden by the operator's env.
      expect(fromHeader).toMatch(/^From: .+ <[^@\s<>]+@[^@\s<>]+>$/);

      expect(findHeader('To')).toBe('To: recipient@example.test');
      expect(findHeader('Subject')).toBe('Subject: Hello, world');
      expect(findHeader('MIME-Version')).toBe('MIME-Version: 1.0');
      expect(findHeader('Content-Type')).toBe('Content-Type: text/plain; charset=UTF-8');
      expect(findHeader('Content-Transfer-Encoding')).toBe('Content-Transfer-Encoding: 8bit');

      // Single-part: no multipart machinery anywhere in the message.
      expect(body).not.toContain('multipart/');
      expect(body).not.toContain('boundary=');

      expect(bodyPart).toBe('plain body line 1');
    } finally {
      m.restore();
    }
  });

  it('produces a multipart/alternative body with both text and html parts and a balanced boundary when html is supplied', async () => {
    const m = installFetchMock('token-abc');
    try {
      await sendEmail({
        to: 'recipient@example.test',
        subject: 'Mixed',
        text: 'plain body',
        html: '<p>html body</p>',
      });

      const body = decodeRaw(m.capture.send!.raw);

      const ctMatch = body.match(
        /Content-Type: multipart\/alternative; boundary="([^"]+)"/,
      );
      expect(ctMatch).not.toBeNull();
      const boundary = ctMatch![1];
      expect(boundary.length).toBeGreaterThan(0);
      // RFC 2046: boundary must not appear inside any encapsulated
      // part. Both bodies are short and known so this is easy to
      // verify directly.
      expect('plain body').not.toContain(boundary);
      expect('<p>html body</p>').not.toContain(boundary);

      // Exactly two opening delimiters (`--<boundary>\r\n`) and
      // exactly one closing delimiter (`--<boundary>--\r\n`).
      const openCount = body.split(`--${boundary}\r\n`).length - 1;
      const closeCount = body.split(`--${boundary}--\r\n`).length - 1;
      expect(openCount).toBe(2);
      expect(closeCount).toBe(1);

      // Both parts present with the right content-type and content.
      expect(body).toContain('Content-Type: text/plain; charset=UTF-8');
      expect(body).toContain('Content-Type: text/html; charset=UTF-8');
      expect(body).toContain('plain body');
      expect(body).toContain('<p>html body</p>');

      // Top-level header block still ends with CRLF CRLF before the
      // first part begins.
      const firstBoundaryIdx = body.indexOf(`--${boundary}`);
      const headerBlock = body.slice(0, firstBoundaryIdx);
      expect(headerBlock).toContain('MIME-Version: 1.0\r\n');
      expect(headerBlock.endsWith('\r\n\r\n')).toBe(true);
    } finally {
      m.restore();
    }
  });

  it('encodes a non-ASCII subject as an RFC 2047 encoded-word', async () => {
    const m = installFetchMock('token-abc');
    try {
      const subject = 'Café — déjà vu';
      await sendEmail({
        to: 'r@example.test',
        subject,
        text: 'x',
      });

      const body = decodeRaw(m.capture.send!.raw);
      const subjectLine = body
        .split('\r\n')
        .find((l) => l.startsWith('Subject: '));
      expect(subjectLine).toBeDefined();

      // Format: =?UTF-8?B?<base64>?=
      const ew = subjectLine!.match(
        /^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/,
      );
      expect(ew).not.toBeNull();
      const decoded = Buffer.from(ew![1], 'base64').toString('utf8');
      expect(decoded).toBe(subject);

      // Header line must be 7-bit clean — the whole point of
      // encoded-word.
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(subjectLine!)).toBe(true);
    } finally {
      m.restore();
    }
  });

  it('throws before any Gmail send when `to` contains CR or LF (only the connector-token probe is allowed to have run)', async () => {
    const m = installFetchMock('token-abc');
    try {
      await expect(
        sendEmail({
          to: 'victim@example.test\r\nBcc: attacker@evil.test',
          subject: 'ok',
          text: 'x',
        }),
      ).rejects.toThrow(/header injection/i);

      // The contract we're protecting: an injected CR/LF must never
      // produce an outbound Gmail send. The connector-token probe
      // happens earlier in `sendEmail` (before the builder runs) and
      // is benign — it doesn't deliver anything — so we pin it
      // explicitly: exactly one fetch call, and it was the probe.
      expect(m.fetchMock).toHaveBeenCalledTimes(1);
      expect(String(m.fetchMock.mock.calls[0][0])).toContain(
        '/api/v2/connection',
      );
      const gmailCalls = m.fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('gmail.googleapis.com'),
      );
      expect(gmailCalls.length).toBe(0);
      expect(m.capture.send).toBeNull();
    } finally {
      m.restore();
    }
  });

  it('throws before any Gmail send when `subject` contains CR or LF (only the connector-token probe is allowed to have run)', async () => {
    const m = installFetchMock('token-abc');
    try {
      await expect(
        sendEmail({
          to: 'r@example.test',
          subject: 'ok\r\nX-Evil: yes',
          text: 'x',
        }),
      ).rejects.toThrow(/header injection/i);

      expect(m.fetchMock).toHaveBeenCalledTimes(1);
      expect(String(m.fetchMock.mock.calls[0][0])).toContain(
        '/api/v2/connection',
      );
      const gmailCalls = m.fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('gmail.googleapis.com'),
      );
      expect(gmailCalls.length).toBe(0);
      expect(m.capture.send).toBeNull();
    } finally {
      m.restore();
    }
  });

  it('throws in production when no Gmail token is available (no silent drop)', async () => {
    // Force the connector lookup to return null without making any
    // network call — getGmailAccessTokenFromConnector short-circuits
    // when REPLIT_CONNECTORS_HOSTNAME is unset.
    delete process.env.REPLIT_CONNECTORS_HOSTNAME;
    process.env.NODE_ENV = 'production';

    // Install a fetch mock anyway so we can prove no network call was
    // made, not even to Gmail.
    const m = installFetchMock(null);
    try {
      await expect(
        sendEmail({ to: 'r@example.test', subject: 's', text: 't' }),
      ).rejects.toThrow(/Gmail not configured/i);
      expect(m.fetchMock).not.toHaveBeenCalled();
    } finally {
      m.restore();
    }
  });

  it('rejects with status, statusText, and the Google error body when Gmail returns a non-2xx response', async () => {
    // We don't reuse installFetchMock here because that helper hard-codes a
    // 200 from Gmail; this test specifically needs the failure branch in
    // sendEmail (the `if (!res.ok)` block) and asserts every piece of
    // diagnostic detail is preserved into the thrown Error.message so the
    // caller's audit log can record useful triage info.
    const errorBody = JSON.stringify({
      error: {
        code: 403,
        message: 'Delegation denied for info@myperfectgame.com',
        status: 'PERMISSION_DENIED',
      },
    });

    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/v2/connection')) {
        return new Response(
          JSON.stringify({ items: [{ settings: { access_token: 'token-abc' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('gmail.googleapis.com')) {
        return new Response(errorBody, {
          status: 403,
          statusText: 'Forbidden',
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in emailService.test.ts: ${u}`);
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    try {
      // Capture the rejection so we can pin every component of the
      // message individually — `rejects.toThrow(/regex/)` would only
      // verify a single substring at a time.
      let caught: unknown = null;
      try {
        await sendEmail({ to: 'r@example.test', subject: 's', text: 't' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      // Status code: required so operators can distinguish 4xx (caller
      // / config issue) from 5xx (Gmail outage).
      expect(msg).toContain('403');
      // statusText: human-readable hint that complements the code.
      expect(msg).toContain('Forbidden');
      // Raw response body: this is where Google's structured error
      // (PERMISSION_DENIED, the offending From address, etc.) lives —
      // dropping it would turn audit-log lines into opaque
      // "send failed" entries.
      expect(msg).toContain('Delegation denied for info@myperfectgame.com');
      expect(msg).toContain('PERMISSION_DENIED');
      // Exactly one Gmail call was made — the failure branch must not
      // retry silently, otherwise the audit log wouldn't reflect what
      // actually hit the wire.
      const gmailCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('gmail.googleapis.com'),
      );
      expect(gmailCalls.length).toBe(1);
    } finally {
      (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('still rejects with the status/statusText (and no secondary error) when reading the Gmail error body itself fails', async () => {
    // Simulate a flaky transport: Gmail returns a non-2xx, but reading
    // the response body throws (e.g. socket reset mid-stream, malformed
    // chunked encoding). The contract is that sendEmail must still
    // reject with the status / statusText so the audit log carries
    // *something* useful — never re-throw the secondary "body read
    // failed" error in place of the original failure.
    const bodyReadError = new Error('simulated body read failure');

    // Hand-rolled Response stand-in: the real Response class doesn't
    // give us a clean way to make `.text()` throw. We only need the
    // surface area sendEmail's failure branch touches: ok, status,
    // statusText, text().
    const failingResponse = {
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => {
        throw bodyReadError;
      },
    };

    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/v2/connection')) {
        return new Response(
          JSON.stringify({ items: [{ settings: { access_token: 'token-abc' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('gmail.googleapis.com')) {
        return failingResponse as unknown as Response;
      }
      throw new Error(`Unexpected fetch in emailService.test.ts: ${u}`);
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    try {
      let caught: unknown = null;
      try {
        await sendEmail({ to: 'r@example.test', subject: 's', text: 't' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const msg = (caught as Error).message;
      // Even with no body to surface, status + statusText must make it
      // into the audit log line.
      expect(msg).toContain('502');
      expect(msg).toContain('Bad Gateway');
      // The "Gmail send failed:" prefix is the load-bearing token
      // operators grep for when triaging bounces. Pin it so a refactor
      // that drops the prefix gets caught here.
      expect(msg).toMatch(/^Gmail send failed:/);

      // Critical: the secondary body-read error must NOT be what
      // bubbles up — that would mask the original Gmail failure and
      // break audit-log triage.
      expect(msg).not.toContain('simulated body read failure');
      expect(caught).not.toBe(bodyReadError);
    } finally {
      (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('reads the access token from the legacy `settings.access_token` shape and forwards it as a Bearer credential to Gmail', async () => {
    // The `installFetchMock` helper already plants the token under
    // `settings.access_token` (the legacy/flat shape), but the existing
    // tests in this file only assert the *body* of the Gmail call. This
    // companion test specifically pins the Authorization header so a
    // future refactor that drops the flat-shape branch in
    // `getGmailAccessTokenFromConnector` fails here instead of in
    // production.
    const m = installFetchMock('legacy-shape-token');
    try {
      await sendEmail({
        to: 'r@example.test',
        subject: 's',
        text: 't',
      });

      const gmailCall = m.fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('gmail.googleapis.com'),
      );
      expect(gmailCall).toBeDefined();
      const init = gmailCall![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer legacy-shape-token');
    } finally {
      m.restore();
    }
  });

  it('reads the access token from the nested `settings.oauth.credentials.access_token` shape and forwards it as a Bearer credential to Gmail', async () => {
    // Forward-compatibility path: newer connector revisions return the
    // OAuth payload nested under `oauth.credentials`. `installFetchMock`
    // hard-codes the legacy flat shape, so we hand-roll the connector
    // response here. If a refactor drops the nested-shape fallback in
    // `getGmailAccessTokenFromConnector`, this test fails before the
    // change reaches a deployment that has the new connector wired.
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/v2/connection')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                settings: {
                  oauth: {
                    credentials: { access_token: 'nested-shape-token' },
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.includes('gmail.googleapis.com')) {
        return new Response(JSON.stringify({ id: 'mock-msg' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch in emailService.test.ts: ${u}`);
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    try {
      await sendEmail({
        to: 'r@example.test',
        subject: 's',
        text: 't',
      });

      const gmailCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes('gmail.googleapis.com'),
      );
      expect(gmailCall).toBeDefined();
      const init = gmailCall![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer nested-shape-token');
    } finally {
      (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('falls back to the unconfigured-token branch (production throw) when the connector returns an item with neither token shape present', async () => {
    // Negative path: the connector probe succeeds and even returns an
    // item, but its `settings` payload contains neither
    // `access_token` nor `oauth.credentials.access_token` (e.g. a
    // future revision swaps the field name again, or the operator
    // wired a partially-provisioned connection). The function must
    // treat that as "no token available" and fall through to the
    // unconfigured branch — in production that means a hard throw, not
    // a silent send with an empty Bearer header.
    process.env.NODE_ENV = 'production';

    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/v2/connection')) {
        // settings exists, but neither shape carries a token.
        return new Response(
          JSON.stringify({
            items: [
              {
                settings: {
                  oauth: { credentials: {} },
                  some_other_field: 'irrelevant',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch in emailService.test.ts: ${u}`);
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;

    try {
      await expect(
        sendEmail({ to: 'r@example.test', subject: 's', text: 't' }),
      ).rejects.toThrow(/Gmail not configured/i);

      // The connector probe is allowed; the Gmail send must not be
      // attempted with an empty / undefined Bearer token.
      const gmailCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('gmail.googleapis.com'),
      );
      expect(gmailCalls.length).toBe(0);
    } finally {
      (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it('writes a developer stub file and resolves in non-production when no Gmail token is available', async () => {
    delete process.env.REPLIT_CONNECTORS_HOSTNAME;
    process.env.NODE_ENV = 'development';

    const stubDir = path.join(os.tmpdir(), 'pg-dev-emails');

    // Snapshot existing entries so we can identify the file this
    // test wrote and clean it up after.
    let before: Set<string>;
    try {
      before = new Set(await fs.readdir(stubDir));
    } catch {
      before = new Set();
    }

    const m = installFetchMock(null);
    try {
      await expect(
        sendEmail({
          to: 'r@example.test',
          subject: 'dev-stub-subject',
          text: 'hello dev',
        }),
      ).resolves.toBeUndefined();

      // Confirms the dev path also avoids the network entirely.
      expect(m.fetchMock).not.toHaveBeenCalled();

      const after = await fs.readdir(stubDir);
      const fresh = after.filter((f) => !before.has(f));
      expect(fresh.length).toBe(1);

      const stubPath = path.join(stubDir, fresh[0]);
      const contents = await fs.readFile(stubPath, 'utf8');
      expect(contents).toContain('to:      r@example.test');
      expect(contents).toContain('subject: dev-stub-subject');
      expect(contents).toContain('hello dev');

      await fs.unlink(stubPath);
    } finally {
      m.restore();
    }
  });

  // ---------------------------------------------------------------------
  // getGmailAccessTokenFromConnector failure paths (Task #149).
  //
  // The helper has three "no usable token" branches that aren't covered
  // anywhere else: the connectors API returns a non-2xx, returns 200 with
  // no usable items/settings shape, or rejects outright. In every one of
  // those cases the function must return null (so sendEmail falls into
  // the unconfigured branch — hard throw in production, dev stub in
  // development) rather than silently sending with an empty Bearer
  // header. The fourth branch (forward-compat nested oauth shape) is
  // already pinned by the "reads the access token from the nested ...
  // shape" test above. The tests below cover the remaining three.
  // ---------------------------------------------------------------------

  /**
   * Snapshot the contents of the dev-stub directory before a test runs.
   * Returns a helper that, after the test, finds the single new file
   * the call wrote, asserts its contents, and unlinks it. Centralised
   * so each branch test can stay focused on the failure mode it pins.
   */
  async function expectDevStubWrittenAfter(
    before: Set<string>,
    expected: { to: string; subject: string; text: string },
  ): Promise<void> {
    const stubDir = path.join(os.tmpdir(), 'pg-dev-emails');
    const after = await fs.readdir(stubDir);
    const fresh = after.filter((f) => !before.has(f));
    expect(fresh.length).toBe(1);
    const stubPath = path.join(stubDir, fresh[0]);
    const contents = await fs.readFile(stubPath, 'utf8');
    expect(contents).toContain(`to:      ${expected.to}`);
    expect(contents).toContain(`subject: ${expected.subject}`);
    expect(contents).toContain(expected.text);
    await fs.unlink(stubPath);
  }

  async function snapshotStubDir(): Promise<Set<string>> {
    const stubDir = path.join(os.tmpdir(), 'pg-dev-emails');
    try {
      return new Set(await fs.readdir(stubDir));
    } catch {
      return new Set();
    }
  }

  /**
   * Install a fetch mock whose only behaviour is to hand a custom
   * Response (or thrown error) back to the connectors-API probe.
   * Anything else is a programming error in the test and surfaces as
   * a thrown "Unexpected fetch" — in particular, a Gmail send must
   * never fire on these branches (no token = no send).
   */
  function installConnectorOnlyFetchMock(
    probeHandler: () => Promise<Response> | Promise<never>,
  ): { fetchMock: ReturnType<typeof vi.fn>; restore: () => void } {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/v2/connection')) return probeHandler();
      throw new Error(`Unexpected fetch in emailService.test.ts: ${u}`);
    });
    (global as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
    return {
      fetchMock,
      restore: () => {
        (global as unknown as { fetch: typeof fetch }).fetch = originalFetch;
      },
    };
  }

  it('throws in production when the connectors API returns a non-2xx response (token fetch returns null, no silent send)', async () => {
    process.env.NODE_ENV = 'production';
    const m = installConnectorOnlyFetchMock(
      async () =>
        new Response('connectors are unwell', {
          status: 503,
          statusText: 'Service Unavailable',
        }),
    );
    try {
      await expect(
        sendEmail({ to: 'r@example.test', subject: 's', text: 't' }),
      ).rejects.toThrow(/Gmail not configured/i);

      // Probe was attempted exactly once; no Gmail send was made.
      expect(m.fetchMock).toHaveBeenCalledTimes(1);
      expect(String(m.fetchMock.mock.calls[0][0])).toContain(
        '/api/v2/connection',
      );
    } finally {
      m.restore();
    }
  });

  it('writes a developer stub file in non-production when the connectors API returns a non-2xx response', async () => {
    process.env.NODE_ENV = 'development';
    const before = await snapshotStubDir();
    const m = installConnectorOnlyFetchMock(
      async () =>
        new Response('connectors are unwell', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    );
    try {
      await expect(
        sendEmail({
          to: 'r@example.test',
          subject: 'non2xx-dev-stub',
          text: 'fell back to dev stub',
        }),
      ).resolves.toBeUndefined();
      expect(m.fetchMock).toHaveBeenCalledTimes(1);
      await expectDevStubWrittenAfter(before, {
        to: 'r@example.test',
        subject: 'non2xx-dev-stub',
        text: 'fell back to dev stub',
      });
    } finally {
      m.restore();
    }
  });

  it('throws in production when the connectors API returns 200 but with no items at all', async () => {
    process.env.NODE_ENV = 'production';
    const m = installConnectorOnlyFetchMock(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      await expect(
        sendEmail({ to: 'r@example.test', subject: 's', text: 't' }),
      ).rejects.toThrow(/Gmail not configured/i);
      expect(m.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      m.restore();
    }
  });

  it('throws in production when the connectors API returns 200 with an item that has no settings field', async () => {
    process.env.NODE_ENV = 'production';
    const m = installConnectorOnlyFetchMock(
      async () =>
        new Response(JSON.stringify({ items: [{}] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      await expect(
        sendEmail({ to: 'r@example.test', subject: 's', text: 't' }),
      ).rejects.toThrow(/Gmail not configured/i);
      expect(m.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      m.restore();
    }
  });

  it('writes a developer stub file in non-production when the connectors API returns 200 with no usable items', async () => {
    process.env.NODE_ENV = 'development';
    const before = await snapshotStubDir();
    const m = installConnectorOnlyFetchMock(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    try {
      await expect(
        sendEmail({
          to: 'r@example.test',
          subject: 'noitems-dev-stub',
          text: 'fell back to dev stub',
        }),
      ).resolves.toBeUndefined();
      expect(m.fetchMock).toHaveBeenCalledTimes(1);
      await expectDevStubWrittenAfter(before, {
        to: 'r@example.test',
        subject: 'noitems-dev-stub',
        text: 'fell back to dev stub',
      });
    } finally {
      m.restore();
    }
  });

  it('throws in production AND logs `emailService.connector_fetch_failed` when the connectors API rejects outright', async () => {
    // The try/catch around getGmailAccessTokenFromConnector inside
    // sendEmail must swallow the rejection (so a transient connectors
    // outage doesn't leak as a confusing low-level fetch error in the
    // password-reset response) but it MUST log the failure so on-call
    // can correlate inbox bounces with connector-side incidents. We
    // pin both the rethrown "Gmail not configured" surface error and
    // the structured log line here.
    process.env.NODE_ENV = 'production';
    const probeError = new Error('simulated connectors network failure');
    const m = installConnectorOnlyFetchMock(async () => {
      throw probeError;
    });
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      await expect(
        sendEmail({ to: 'r@example.test', subject: 's', text: 't' }),
      ).rejects.toThrow(/Gmail not configured/i);

      // Probe attempted exactly once; no retry, no Gmail send.
      expect(m.fetchMock).toHaveBeenCalledTimes(1);

      // The structured log line carries the probe error's message in
      // the errorContext payload — verify both the tag and that the
      // underlying error wasn't lost.
      const failureCall = errorSpy.mock.calls.find(
        ([msg]) => msg === 'emailService.connector_fetch_failed',
      );
      expect(failureCall).toBeDefined();
      const ctx = failureCall![1] as { errorMessage?: string } | undefined;
      expect(ctx?.errorMessage).toBe('simulated connectors network failure');
    } finally {
      m.restore();
    }
  });

  it('writes a developer stub file in non-production AND logs `emailService.connector_fetch_failed` when the connectors API rejects outright', async () => {
    process.env.NODE_ENV = 'development';
    const probeError = new Error('simulated connectors network failure');
    const before = await snapshotStubDir();
    const m = installConnectorOnlyFetchMock(async () => {
      throw probeError;
    });
    const errorSpy = vi.spyOn(logger, 'error');
    try {
      await expect(
        sendEmail({
          to: 'r@example.test',
          subject: 'reject-dev-stub',
          text: 'fell back to dev stub',
        }),
      ).resolves.toBeUndefined();

      expect(m.fetchMock).toHaveBeenCalledTimes(1);
      await expectDevStubWrittenAfter(before, {
        to: 'r@example.test',
        subject: 'reject-dev-stub',
        text: 'fell back to dev stub',
      });

      const failureCall = errorSpy.mock.calls.find(
        ([msg]) => msg === 'emailService.connector_fetch_failed',
      );
      expect(failureCall).toBeDefined();
      const ctx = failureCall![1] as { errorMessage?: string } | undefined;
      expect(ctx?.errorMessage).toBe('simulated connectors network failure');
    } finally {
      m.restore();
    }
  });
});
