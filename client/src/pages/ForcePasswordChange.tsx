import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/lib/queryClient';

/**
 * Forced password-rotation gate (Task #55).
 *
 * Displayed in place of the rest of the app whenever the authenticated
 * user's `mustRotatePassword` flag is true — meaning their stored
 * password predates the current strong-password policy. The user can:
 *   1. Set or update their own recovery email (Task #98) so the reset
 *      flow has somewhere to send the link to.
 *   2. Trigger the existing email-verified reset flow against their own
 *      account, then click the link from their inbox to complete
 *      rotation on the public /reset page.
 *   3. Sign out.
 *
 * The rotation itself happens via the unchanged
 * /api/auth/complete-reset endpoint, which clears `mustRotatePassword`
 * on success. The next /api/auth/me call will then unlock the app.
 */
export default function ForcePasswordChange() {
  const { user, logout } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Recovery-email management state.
  const [emailInput, setEmailInput] = useState('');
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  // On mount (and whenever user.email changes after a confirm),
  // ask the server whether there's an outstanding verification so we
  // can render the "check your inbox" hint after a refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest('GET', '/api/auth/me/email/pending');
        if (!cancelled && res?.pending) {
          setPendingEmail(res.pendingEmail || null);
        }
      } catch {
        // Non-fatal — UI just won't show the hint.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.email]);

  const onRequestReset = async () => {
    if (!user?.username) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);
    try {
      const res = await apiRequest('POST', '/api/auth/request-reset', {
        body: JSON.stringify({ usernameOrEmail: user.username }),
        headers: { 'Content-Type': 'application/json' },
      });
      setSuccessMessage(
        res?.message ||
          'If your account has a recovery email on file, a reset link has been sent. Check your inbox.',
      );
    } catch (error) {
      console.error('Forced reset request error:', error);
      setErrorMessage(
        'Unable to send a reset link right now. Please try again in a few minutes.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const onRequestEmailVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    const proposed = emailInput.trim();
    // Cheap client-side sanity check; the server enforces the real rule.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(proposed)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailSubmitting(true);
    try {
      const res = await apiRequest('POST', '/api/auth/me/email/start-verification', {
        body: JSON.stringify({ email: proposed }),
        headers: { 'Content-Type': 'application/json' },
      });
      setPendingEmail(res?.pendingEmail || proposed);
      setEmailInput('');
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Unable to send a verification email. Please try again later.';
      setEmailError(msg);
    } finally {
      setEmailSubmitting(false);
    }
  };

  const hasEmail = Boolean(user?.email);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 py-8">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <div className="mb-6 text-center">
          <img src="/images/PG_logo_web.PNG" alt="Perfect Game Logo" className="mx-auto h-24" />
          <h1 className="mt-4 text-xl font-semibold text-gray-800">
            Password update required
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            Your password no longer meets our security policy. You must
            change it before you can continue using the dashboard.
          </p>
        </div>

        {errorMessage && (
          <div className="mb-4 rounded bg-red-100 p-3 text-red-700">{errorMessage}</div>
        )}
        {successMessage && (
          <div className="mb-4 rounded bg-green-100 p-3 text-green-700">
            {successMessage}
          </div>
        )}

        {/* Recovery email management. Always visible so a user with an
            email on file can still update it (e.g. after losing access to
            the original inbox). */}
        <div className="mb-6 rounded border border-gray-200 bg-gray-50 p-4">
          <h2 className="text-sm font-semibold text-gray-800">
            Recovery email
          </h2>
          {hasEmail ? (
            <p className="mt-1 text-sm text-gray-600">
              Current: <span className="font-mono">{user?.email}</span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-amber-700">
              No recovery email is on file for your account. Add one below so
              we have somewhere to send your reset link.
            </p>
          )}

          {pendingEmail && (
            <p className="mt-2 rounded bg-blue-50 p-2 text-sm text-blue-800">
              We've sent a verification link to{' '}
              <span className="font-mono">{pendingEmail}</span>. Click the
              link in that email to attach it to your account, then come back
              and request your reset link.
            </p>
          )}

          <form onSubmit={onRequestEmailVerification} className="mt-3 space-y-2">
            <label htmlFor="recovery-email" className="block text-xs font-medium text-gray-700">
              {hasEmail ? 'Change recovery email' : 'Set recovery email'}
            </label>
            <input
              id="recovery-email"
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500 text-black"
            />
            {emailError && (
              <p className="text-sm text-red-600">{emailError}</p>
            )}
            <button
              type="submit"
              disabled={emailSubmitting || emailInput.trim() === ''}
              className="w-full rounded-md bg-gray-700 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:bg-gray-400"
            >
              {emailSubmitting ? 'Sending verification...' : 'Send verification email'}
            </button>
            <p className="text-xs text-gray-500">
              We'll send a one-time link to that address. Click it within
              30 minutes to attach the email to your account.
            </p>
          </form>
        </div>

        <div className="space-y-3 text-sm text-gray-700">
          <p>
            Click the button below and we'll email you a one-time link to
            choose a new password. The link expires in 30 minutes.
          </p>
          {!hasEmail && (
            <p className="text-amber-700">
              You'll need to verify a recovery email above before this can
              deliver anything.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onRequestReset}
          disabled={isSubmitting}
          className="mt-4 w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
        >
          {isSubmitting ? 'Sending...' : 'Send me a reset link'}
        </button>

        <button
          type="button"
          onClick={() => {
            logout();
          }}
          className="mt-3 w-full rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
