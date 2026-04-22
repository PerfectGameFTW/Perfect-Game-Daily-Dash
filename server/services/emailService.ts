/**
 * Email Service
 *
 * Provider-agnostic outbound email. In production we send via the
 * Replit SendGrid integration (connector_name=sendgrid), which exposes
 * the SendGrid API key and verified sender address through the Replit
 * connectors API. The integration is the recommended production path
 * because it handles credential rotation centrally — no SENDGRID_API_KEY
 * env var needs to be managed by hand.
 *
 * For backwards compatibility / non-Replit hosts, a raw SENDGRID_API_KEY
 * env var is still honored. If neither path is available (typical dev),
 * the message is logged to the workflow console so the password-reset
 * flow can be exercised end-to-end without email infrastructure.
 */

import sgMail from '@sendgrid/mail';

const FROM_EMAIL_OVERRIDE = process.env.MAIL_FROM_EMAIL;
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Perfect Game Sales Dashboard';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

interface SendGridCredentials {
  apiKey: string;
  fromEmail: string;
}

/**
 * Fetch SendGrid credentials from the Replit connectors API. Returns
 * null when the integration is not wired (so the caller can fall back
 * to the raw env var or the dev console stub). Throws only on a real
 * runtime error talking to the connectors API.
 *
 * Tokens behind the connectors API can rotate, so this is intentionally
 * uncached — every send re-fetches.
 */
async function getSendGridCredentialsFromConnector(): Promise<SendGridCredentials | null> {
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
      '/api/v2/connection?include_secrets=true&connector_names=sendgrid',
    {
      headers: {
        Accept: 'application/json',
        'X-Replit-Token': xReplitToken,
      },
    },
  );
  if (!res.ok) return null;

  const data = (await res.json()) as { items?: Array<{ settings?: Record<string, string> }> };
  const settings = data.items?.[0]?.settings;
  if (!settings || !settings.api_key || !settings.from_email) return null;

  return { apiKey: settings.api_key, fromEmail: settings.from_email };
}

/**
 * Send an email. Resolves on a delivery attempt; throws only on a hard
 * configuration error (e.g. SendGrid returns 4xx with the API key set).
 * The console fallback always succeeds so dev flows are never blocked.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  let apiKey = process.env.SENDGRID_API_KEY || '';
  let fromEmail = FROM_EMAIL_OVERRIDE || '';

  if (!apiKey) {
    try {
      const creds = await getSendGridCredentialsFromConnector();
      if (creds) {
        apiKey = creds.apiKey;
        if (!fromEmail) fromEmail = creds.fromEmail;
      }
    } catch (err) {
      console.error(
        '[emailService] Failed to fetch SendGrid credentials from connector:',
        err,
      );
    }
  }

  if (!apiKey) {
    if (process.env.NODE_ENV === 'production') {
      // In production, refuse to silently swallow recovery emails.
      throw new Error(
        'SendGrid not configured: connect the SendGrid integration or set SENDGRID_API_KEY.',
      );
    }
    // Dev / unconfigured: log to stdout so the developer can copy the
    // reset link out of the workflow logs.
    console.warn(
      '[emailService] SendGrid not configured; falling back to console log. ' +
        'Wire the SendGrid integration (or set SENDGRID_API_KEY) for real delivery.',
    );
    console.log(
      `[emailService:dev-stub]\n  to:      ${msg.to}\n  from:    ${FROM_NAME} <${fromEmail || 'no-reply@perfectgame.local'}>\n  subject: ${msg.subject}\n  text:\n${msg.text}`,
    );
    return;
  }

  if (!fromEmail) {
    throw new Error(
      'SendGrid sender address is not configured: set MAIL_FROM_EMAIL or wire the SendGrid integration with a verified sender.',
    );
  }

  sgMail.setApiKey(apiKey);
  await sgMail.send({
    to: msg.to,
    from: { email: fromEmail, name: FROM_NAME },
    subject: msg.subject,
    text: msg.text,
    ...(msg.html ? { html: msg.html } : {}),
  });
}
