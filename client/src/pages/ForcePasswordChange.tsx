import { useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/lib/queryClient';

/**
 * Forced password-rotation gate (Task #55).
 *
 * Displayed in place of the rest of the app whenever the authenticated
 * user's `mustRotatePassword` flag is true — meaning their stored
 * password predates the current strong-password policy. The user can:
 *   1. Trigger the existing email-verified reset flow against their own
 *      account, then click the link from their inbox to complete
 *      rotation on the public /reset page; or
 *   2. Sign out.
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

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
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

        <div className="space-y-3 text-sm text-gray-700">
          <p>
            Click the button below and we'll email you a one-time link to
            choose a new password. The link expires in 30 minutes.
          </p>
          <p className="text-gray-500">
            If we don't have a recovery email on file for your account,
            no email will arrive — please contact an administrator to set
            one up.
          </p>
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
          onClick={() => logout()}
          className="mt-3 w-full rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
