/**
 * Email Service
 *
 * Provider-agnostic outbound email. Today we support SendGrid via its
 * REST API when SENDGRID_API_KEY is set; otherwise (dev / unconfigured)
 * we log the message to the server console and return success. This lets
 * the password-reset flow be exercised end-to-end in development without
 * requiring email infrastructure, while production deployments simply
 * need to set SENDGRID_API_KEY (and optionally MAIL_FROM_EMAIL).
 *
 * Wiring SendGrid via the Replit integrations system is the
 * recommended production path — that path also populates
 * SENDGRID_API_KEY, so this code does not need to change.
 */

const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || 'no-reply@perfectgame.local';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Perfect Game Sales Dashboard';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an email. Resolves on a delivery attempt; throws only on a hard
 * configuration error (e.g. SendGrid returns 4xx with the API key set).
 * The console fallback always succeeds so dev flows are never blocked.
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;

  if (!apiKey) {
    // Dev / unconfigured: log to stdout so the developer can copy the
    // reset link out of the workflow logs. Never log this to a shared
    // console in production — but in production SENDGRID_API_KEY will be
    // set and this branch will not execute.
    console.warn(
      '[emailService] SENDGRID_API_KEY not set; falling back to console log. ' +
        'Set the env var (or wire the SendGrid integration) for real delivery.',
    );
    console.log(
      `[emailService:dev-stub]\n  to:      ${msg.to}\n  from:    ${FROM_NAME} <${FROM_EMAIL}>\n  subject: ${msg.subject}\n  text:\n${msg.text}`,
    );
    return;
  }

  const body = {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: msg.subject,
    content: [
      { type: 'text/plain', value: msg.text },
      ...(msg.html ? [{ type: 'text/html', value: msg.html }] : []),
    ],
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SendGrid send failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
    );
  }
}
