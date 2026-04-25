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

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { logger, errorContext } from '../logger';

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
 * Fetch a Gmail OAuth access token from the Replit connectors API. Returns
 * null when the integration is not wired (so the caller can fall back to
 * the dev console stub). Throws only on a real runtime error talking to
 * the connectors API.
 *
 * Tokens behind the connectors API rotate, so this is intentionally
 * uncached — every send re-fetches.
 */
async function getGmailAccessTokenFromConnector(): Promise<string | null> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) return null;

  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;
  if (!xReplitToken) return null;

  const res = await fetch(
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
  if (!res.ok) return null;

  const data = (await res.json()) as {
    items?: Array<{ settings?: Record<string, unknown> }>;
  };
  const settings = data.items?.[0]?.settings;
  if (!settings) return null;

  // The connectors API returns the access token under either `access_token`
  // (the OAuth field name) or nested under `oauth.credentials.access_token`
  // depending on the connector revision. Check both for forward
  // compatibility.
  const direct = typeof settings.access_token === 'string' ? settings.access_token : '';
  if (direct) return direct;
  const oauth = settings.oauth as
    | { credentials?: { access_token?: unknown } }
    | undefined;
  const nested =
    typeof oauth?.credentials?.access_token === 'string'
      ? oauth.credentials.access_token
      : '';
  return nested || null;
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

  let accessToken: string | null = null;
  try {
    accessToken = await getGmailAccessTokenFromConnector();
  } catch (err) {
    logger.error('emailService.connector_fetch_failed', errorContext(err));
  }

  if (!accessToken) {
    if (process.env.NODE_ENV === 'production') {
      // In production, refuse to silently swallow recovery emails.
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

  const raw = base64url(buildRfc5322Message(msg, fromEmail));
  const res = await fetch(
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
    throw new Error(
      `Gmail send failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
}
