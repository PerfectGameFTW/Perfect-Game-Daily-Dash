import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { apiRequest } from '@/lib/queryClient';
import { useAuth } from '@/context/AuthContext';

/**
 * Confirms a recovery-email verification token (Task #98).
 *
 * The link target lives at /verify-email?token=... and is hit by
 * whichever browser the user opens the email in — which may not have
 * the user's session cookie. Possession of the 256-bit token is the
 * proof of email control, so the confirm endpoint is unauthenticated.
 *
 * On success we kick `checkAuth()` so any *currently* signed-in tab
 * re-fetches `/api/auth/me` and immediately reflects the new email
 * (e.g. the ForcePasswordChange screen lifts the "no email on file"
 * warning).
 */
export default function VerifyEmail() {
  const [, navigate] = useLocation();
  const { isAuthenticated, checkAuth } = useAuth();
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState<string>('');
  const [confirmedEmail, setConfirmedEmail] = useState<string | null>(null);

  const token = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const t = new URLSearchParams(window.location.search).get('token') || '';
    // Strip the token from the visible URL (and history entry) before
    // any async work runs, so it can't be picked up by a service-worker
    // GET cache, browser history, screen-share, or referer header on
    // any subsequent navigation/asset request from this page.
    if (t) {
      try {
        window.history.replaceState({}, '', window.location.pathname);
      } catch {
        /* non-fatal */
      }
    }
    return t;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) {
        setStatus('error');
        setMessage(
          'This verification link is missing its token. Please use the link from your email exactly as we sent it.',
        );
        return;
      }
      try {
        const res = await apiRequest('POST', '/api/auth/me/email/confirm', {
          body: JSON.stringify({ token }),
          headers: { 'Content-Type': 'application/json' },
        });
        if (cancelled) return;
        if (res?.success) {
          setStatus('success');
          setConfirmedEmail(res.email || null);
          // Best-effort refresh; ignore failures.
          checkAuth().catch(() => {});
        } else {
          setStatus('error');
          setMessage(
            res?.error ||
              'This verification link is invalid or has expired. Please request a new one.',
          );
        }
      } catch (error: unknown) {
        if (cancelled) return;
        const msg =
          error instanceof Error
            ? error.message
            : 'This verification link is invalid or has expired. Please request a new one.';
        setStatus('error');
        setMessage(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally only run this once per mount on the URL token —
    // re-running on auth changes would consume the token a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <div className="mb-6 text-center">
          <img src="/images/PG_logo_web.PNG" alt="Perfect Game Logo" className="mx-auto h-24" />
          <h1 className="mt-4 text-xl font-semibold text-gray-800">
            Recovery email verification
          </h1>
        </div>

        {status === 'pending' && (
          <div className="rounded bg-gray-100 p-3 text-center text-sm text-gray-700">
            Confirming your email...
          </div>
        )}
        {status === 'success' && (
          <div className="rounded bg-green-100 p-3 text-sm text-green-800">
            <p>
              Your recovery email{' '}
              {confirmedEmail && (
                <>
                  (<span className="font-mono">{confirmedEmail}</span>){' '}
                </>
              )}
              has been confirmed and attached to your account.
            </p>
            <p className="mt-2">
              You can now request a password reset and the link will be
              delivered to that address.
            </p>
          </div>
        )}
        {status === 'error' && (
          <div className="rounded bg-red-100 p-3 text-sm text-red-700">
            {message}
          </div>
        )}

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => navigate(isAuthenticated ? '/' : '/login')}
            className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
          >
            {isAuthenticated ? 'Back to dashboard' : 'Back to sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
