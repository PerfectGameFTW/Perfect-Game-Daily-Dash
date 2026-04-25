/**
 * Email Service
 *
 * Sends transactional email (password resets, recovery-email verification)
 * via the Replit Gmail connector — i.e. through the Workspace mailbox the
 * operator OAuth'd at setup time. The connectors API hands us a short-lived
 * access token on every send (it's intentionally uncached because tokens
 * rotate); we then call the Gmail REST API
 * (`users.messages.send`) directly so we don't pull in the heavy
 * `googleapis` SDK just for one call.
 *
 * Default From address is `info@myperfectgame.com`. `MAIL_FROM_EMAIL` will
 * override it for any deployment that needs to send as a different verified
 * alias. Gmail will only accept a From address that is either the
 * authenticated user's primary mailbox OR a "send mail as" alias the user
 * has set up in Gmail settings, so the From and the connected account must
 * line up — otherwise Gmail rewrites or rejects the message.
 *
 * Dev fallback: if no connector token is available and we are NOT in
 * production, the message body is written to a developer-only file under
 * the OS temp dir so the password-reset flow stays exercise-able locally
 * without real email infrastructure. Production refuses to silently swallow
 * the email — `sendEmail` throws so the auth flow surfaces a real error.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { logger, errorContext, type LogContext } from '../logger';
import { emailAlerter } from './emailAlert';

const FROM_EMAIL_OVERRIDE = process.env.MAIL_FROM_EMAIL;
const DEFAULT_FROM_EMAIL = 'info@myperfectgame.com';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Perfect Game Sales Dashboard';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Tagged outcome of a Gmail-token lookup against the Replit connectors API.
 *
 * The two failure modes look identical from the call site (no token to send
 * with) but mean very different things to an operator triaging a missing
 * password-reset email:
 *
 *   - `unconfigured` — nobody has wired the Gmail integration in this
 *     environment yet, or the wired connection genuinely has no token in
 *     either of the two known shapes. Action: connect Gmail.
 *
 *   - `connector_failed` — the connectors API itself returned a non-2xx,
 *     dropped the connection, or sent a body we couldn't parse. Action:
 *     wait it out / check Replit status; reconnecting Gmail won't help.
 *
 * `cause` carries the underlying thrown value (network / JSON failures) so
 * the structured log line can preserve `errorMessage` and `stack` via
 * `errorContext`. `status` is set on HTTP non-2xx so the log line can carry
 * the response code and operators can grep recent failures by status.
 */
type ConnectorTokenResult =
  | { kind: 'token'; token: string }
  | { kind: 'unconfigured' }
  | {
      kind: 'connector_failed';
      reason: string;
      status?: number;
      cause?: unknown;
    };

/**
 * Fetch a Gmail OAuth access token from the Replit connectors API. Never
 * throws — every failure path is encoded in the returned tag so the caller
 * can distinguish "Gmail not wired" from "connectors API is down" and
 * surface a triage-friendly error to operators.
 *
 * Tokens behind the connectors API rotate, so this is intentionally
 * uncached — every send re-fetches.
 */
async function getGmailAccessTokenFromConnector(): Promise<ConnectorTokenResult> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) return { kind: 'unconfigured' };

  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;
  if (!xReplitToken) return { kind: 'unconfigured' };

  let res: Response;
  try {
    res = await fetch(
      'https://' +
        hostname +
        '/api/v2/connection?include_secrets=true&connector_names=google-mail',
      {
        headers: {
          Accept: 'application/json',
          'X-Replit-Token': xReplitToken,
        },
      },
    );
  } catch (err) {
    // Network-level failure (DNS, ECONNREFUSED, TLS, abort, ...). Treat
    // as connector-down rather than collapsing to "not configured" so the
    // operator-facing error is actionable.
    return {
      kind: 'connector_failed',
      reason: err instanceof Error ? err.message : String(err),
      cause: err,
    };
  }

  if (!res.ok) {
    return {
      kind: 'connector_failed',
      reason: `${res.status} ${res.statusText}`,
      status: res.status,
    };
  }

  let data: { items?: Array<{ settings?: Record<string, unknown> }> };
  try {
    data = (await res.json()) as {
      items?: Array<{ settings?: Record<string, unknown> }>;
    };
  } catch (err) {
    // 200 OK but the body wasn't JSON we could parse. That's the
    // connectors API misbehaving, not a missing wiring — surface it
    // with the connector-down branch.
    return {
      kind: 'connector_failed',
      reason:
        'malformed connectors API JSON: ' +
        (err instanceof Error ? err.message : String(err)),
      status: res.status,
      cause: err,
    };
  }

  const settings = data.items?.[0]?.settings;
  if (!settings) return { kind: 'unconfigured' };

  // The connectors API returns the access token under either `access_token`
  // (the OAuth field name) or nested under `oauth.credentials.access_token`
  // depending on the connector revision. Check both for forward
  // compatibility.
  const direct = typeof settings.access_token === 'string' ? settings.access_token : '';
  if (direct) return { kind: 'token', token: direct };
  const oauth = settings.oauth as
    | { credentials?: { access_token?: unknown } }
    | undefined;
  const nested =
    typeof oauth?.credentials?.access_token === 'string'
      ? oauth.credentials.access_token
      : '';
  if (nested) return { kind: 'token', token: nested };
  return { kind: 'unconfigured' };
}

/**
 * Strip CR / LF from a header value before it gets concatenated into the
 * RFC 5322 message. Defense-in-depth against header injection: every
 * caller already passes values from validated schemas (recovery-email
 * Zod parser, hard-coded subject strings) so this should never fire,
 * but a smuggled `\r\nBcc: attacker@evil.test` would otherwise let an
 * upstream validation regression silently turn `sendEmail` into an open
 * relay. Throwing here makes the regression loud instead of dangerous.
 */
function assertNoHeaderInjection(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `emailService: refusing to send — ${field} contains a CR/LF and would allow header injection.`,
    );
  }
}

/**
 * RFC 2047 encoded-word for any header value that contains non-ASCII.
 * Gmail accepts UTF-8 in MIME bodies but headers must be 7-bit clean.
 */
function encodeHeaderValue(value: string): string {
  // Fast path: pure ASCII subjects / display names go through unchanged.
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

/**
 * Build an RFC 5322 message body. When `html` is supplied we emit a
 * multipart/alternative payload so clients that prefer HTML get the
 * styled version while plaintext-only clients (and search indexers) still
 * see the text part.
 */
function buildRfc5322Message(
  msg: EmailMessage,
  fromEmail: string,
): string {
  // Reject CR/LF in any header-bound value before assembling the message.
  // See assertNoHeaderInjection for rationale.
  assertNoHeaderInjection('to', msg.to);
  assertNoHeaderInjection('subject', msg.subject);
  assertNoHeaderInjection('from email', fromEmail);
  assertNoHeaderInjection('from name', FROM_NAME);

  const fromHeader = `${encodeHeaderValue(FROM_NAME)} <${fromEmail}>`;
  const subject = encodeHeaderValue(msg.subject);
  const headersBase =
    `From: ${fromHeader}\r\n` +
    `To: ${msg.to}\r\n` +
    `Subject: ${subject}\r\n` +
    `MIME-Version: 1.0\r\n`;

  if (!msg.html) {
    return (
      headersBase +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      'Content-Transfer-Encoding: 8bit\r\n' +
      '\r\n' +
      msg.text
    );
  }

  // Boundary needs to be unguessable enough to never collide with content,
  // but is otherwise opaque — random bytes in hex satisfies the RFC's
  // "must not appear in any encapsulated part" requirement in practice.
  const boundary = `bnd_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 14)}`;
  return (
    headersBase +
    `Content-Type: multipart/alternative; boundary="${boundary}"\r\n` +
    '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: 8bit\r\n' +
    '\r\n' +
    msg.text +
    '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n' +
    'Content-Transfer-Encoding: 8bit\r\n' +
    '\r\n' +
    msg.html +
    '\r\n' +
    `--${boundary}--\r\n`
  );
}

/**
 * Short, deterministic hash of a recipient address for the audit log
 * (Task #104). 12 hex chars (48 bits) is plenty for log triage —
 * repeat failures to the same inbox aggregate visibly without ever
 * writing the literal address to disk. Lower-cased before hashing
 * so equivalent addresses collide regardless of casing.
 */
function recipientHash(to: string): string {
  return createHash('sha256').update(to.toLowerCase()).digest('hex').slice(0, 12);
}

/** base64url per RFC 4648 §5 — Gmail's `raw` field requires it. */
function base64url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Send an email. Resolves on a successful Gmail API response; throws on
 * any hard configuration / API error so the caller's audit log records
 * the failure rather than silently dropping the message. The dev-mode
 * file fallback always succeeds so local flows are never blocked.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const fromEmail = FROM_EMAIL_OVERRIDE || DEFAULT_FROM_EMAIL;

  // The helper is contracted not to throw, but a defensive try/catch keeps
  // a future regression (or a thrown value from inside fetch's response
  // teardown) from short-circuiting sendEmail before the dev-stub fallback
  // gets a chance to run.
  let tokenResult: ConnectorTokenResult;
  try {
    tokenResult = await getGmailAccessTokenFromConnector();
  } catch (err) {
    tokenResult = {
      kind: 'connector_failed',
      reason: err instanceof Error ? err.message : String(err),
      cause: err,
    };
  }

  // Connector-API-down case: emit a structured log line so on-call can
  // grep recent failures by status without re-running the request, and so
  // bounces can be correlated with connectors-side incidents. We do this
  // BEFORE the test-env guard because the failure is real regardless of
  // NODE_ENV — operators in CI logs care just as much. The recipient
  // hash is included so a connector incident can be correlated with the
  // downstream `emailService.send_failed` line for the same message.
  if (tokenResult.kind === 'connector_failed') {
    const ctx: LogContext =
      tokenResult.cause !== undefined
        ? errorContext(tokenResult.cause)
        : { errorMessage: tokenResult.reason };
    if (tokenResult.status !== undefined) ctx.status = tokenResult.status;
    ctx.recipientHash = recipientHash(msg.to);
    logger.error('emailService.connector_fetch_failed', ctx);
  }

  let accessToken: string | null =
    tokenResult.kind === 'token' ? tokenResult.token : null;

  // Test-environment safety guard: when NODE_ENV === 'test', refuse to
  // touch the real Gmail-send branch unless a test has explicitly
  // opted in by setting EMAIL_TEST_ALLOW_REAL_SEND. Without this guard
  // any test that drives the password-reset or recovery-email route
  // against a dev/CI environment with the Gmail connector wired up
  // (which is now the default) would issue real outbound mail to
  // fixture addresses like `__pr_test_with_email__@example.test`,
  // generating bounces against the operator's Workspace inbox and
  // burning their daily Gmail send quota. Direct emailService unit
  // tests that intentionally exercise the Gmail branch with a mocked
  // global.fetch set EMAIL_TEST_ALLOW_REAL_SEND in their setup.
  if (
    accessToken &&
    process.env.NODE_ENV === 'test' &&
    process.env.EMAIL_TEST_ALLOW_REAL_SEND !== '1'
  ) {
    accessToken = null;
  }

  if (!accessToken) {
    if (process.env.NODE_ENV === 'production') {
      // In production, refuse to silently swallow recovery emails. The
      // two failure modes get distinct messages so an operator reading
      // the audit log can tell whether to reconnect Gmail (configuration
      // problem on our side) or wait for the connectors API to recover
      // (transient platform problem). Both also feed the email alerter
      // (Task #104) so a sustained outage pages on-call instead of
      // sitting unread in the audit log.
      if (tokenResult.kind === 'connector_failed') {
        const reason =
          tokenResult.status !== undefined
            ? `connector_failed_${tokenResult.status}`
            : 'connector_failed';
        emailAlerter.record(reason);
        const failCtx: LogContext = {
          recipientHash: recipientHash(msg.to),
          reason,
          errorMessage: tokenResult.reason,
        };
        if (tokenResult.status !== undefined) failCtx.status = tokenResult.status;
        logger.error('emailService.send_failed', failCtx);
        throw new Error(
          `Gmail connector API unavailable: the Replit connectors API is not reachable (${tokenResult.reason}). Retry shortly; if the failure persists, check Replit status before reconnecting Gmail.`,
        );
      }
      emailAlerter.record('unconfigured');
      logger.error('emailService.send_failed', {
        recipientHash: recipientHash(msg.to),
        reason: 'unconfigured',
        errorMessage: 'Gmail integration not wired',
      });
      throw new Error(
        'Gmail not configured: connect the Gmail integration in Replit so the dashboard can send password-reset email.',
      );
    }
    // Dev / unconfigured: persist the outbound message to a developer-only
    // file under the OS temp dir so the password-reset flow remains testable
    // without a real Gmail backend, but the recipient address, subject, and
    // reset link never reach the (workspace-visible) workflow logs. The
    // structured log line carries only the file path so the developer can
    // `cat` it out of band. Production refuses to silently swallow the
    // email above.
    const dir = path.join(os.tmpdir(), 'pg-dev-emails');
    let filePath: string | null = null;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      filePath = path.join(
        dir,
        `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.txt`,
      );
      const body =
        `to:      ${msg.to}\n` +
        `from:    ${FROM_NAME} <${fromEmail}>\n` +
        `subject: ${msg.subject}\n` +
        `text:\n${msg.text}\n`;
      await fs.writeFile(filePath, body, { mode: 0o600 });
    } catch (err) {
      logger.error('emailService.dev_stub_write_failed', errorContext(err));
    }
    logger.warn(
      'emailService.dev_stub_used',
      filePath ? { path: filePath } : undefined,
    );
    return;
  }

  // Header-injection guard lives inside buildRfc5322Message and throws
  // synchronously. Catching it here lets us record the failure in the
  // alerter and audit log alongside every other "send blocked" path
  // before re-throwing — otherwise a sudden spike in injection attempts
  // would be invisible to on-call.
  let raw: string;
  try {
    raw = base64url(buildRfc5322Message(msg, fromEmail));
  } catch (err) {
    emailAlerter.record('header_injection');
    logger.error('emailService.send_failed', {
      recipientHash: recipientHash(msg.to),
      reason: 'header_injection',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Network-level failure on the Gmail call (DNS, ECONNREFUSED, TLS,
  // abort, ...). Distinct from a non-2xx response — that has a status
  // code; this doesn't.
  let res: Response;
  try {
    res = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ raw }),
      },
    );
  } catch (err) {
    emailAlerter.record('gmail_network_error');
    logger.error('emailService.send_failed', {
      recipientHash: recipientHash(msg.to),
      reason: 'gmail_network_error',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `Gmail send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    // Surface the Gmail error body so the caller's audit log carries
    // useful detail (status, googleError.message) instead of an opaque
    // "send failed". Body is read defensively — Gmail occasionally
    // returns plaintext on infra errors.
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    const reason = `gmail_send_failed_${res.status}`;
    emailAlerter.record(reason);
    logger.error('emailService.send_failed', {
      recipientHash: recipientHash(msg.to),
      reason,
      status: res.status,
      errorMessage: detail || res.statusText,
    });
    throw new Error(
      `Gmail send failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }

  // Success path. Parse the Gmail messageId so the audit log carries
  // a handle operators can correlate with Gmail's own message log when
  // a user reports "I never got it". Response body parsing is best-
  // effort — a missing/malformed body should not turn a successful
  // delivery into an error.
  let gmailMessageId: string | undefined;
  try {
    const data = (await res.json()) as { id?: unknown };
    if (typeof data.id === 'string' && data.id.length > 0) {
      gmailMessageId = data.id;
    }
  } catch {
    /* swallow — send already succeeded; missing id is not fatal. */
  }
  const okCtx: LogContext = { recipientHash: recipientHash(msg.to) };
  if (gmailMessageId !== undefined) okCtx.gmailMessageId = gmailMessageId;
  logger.info('emailService.send_succeeded', okCtx);
}
