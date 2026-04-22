import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { apiRequest } from '@/lib/queryClient';

const loginSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  // Login validation is intentionally permissive (matches the server's
  // login schema) so legacy accounts created before the strong-password
  // policy can still sign in. Strong-password rules apply to the reset
  // form below.
  password: z.string().min(1, 'Password is required'),
});

// Email-verified reset: step 1 only collects an identifier and triggers
// a one-time link to be emailed to the account owner. The new password
// is collected on the dedicated /reset page after the user clicks the
// link, so this form does not ask for a password.
const resetSchema = z.object({
  usernameOrEmail: z
    .string()
    .min(1, 'Enter your username or email address')
    .max(254),
});

// TOTP step. Accepts either a 6-digit numeric code OR a formatted
// recovery code like "ABCDE-FGHIJ". The server normalises spacing/
// dashes/case before comparing.
const totpSchema = z.object({
  code: z
    .string()
    .min(6, 'Enter the 6-digit code from your authenticator app')
    .max(32),
});

type LoginFormValues = z.infer<typeof loginSchema>;
type ResetFormValues = z.infer<typeof resetSchema>;
type TotpFormValues = z.infer<typeof totpSchema>;

export default function Login() {
  const { login, checkAuth } = useAuth();
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<'login' | 'totp' | 'reset'>('login');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const totpForm = useForm<TotpFormValues>({
    resolver: zodResolver(totpSchema),
    defaultValues: { code: '' },
  });

  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const resetForm = useForm<ResetFormValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { usernameOrEmail: '' },
  });

  const switchMode = (next: 'login' | 'totp' | 'reset') => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setMode(next);
  };

  const onLogin = async (data: LoginFormValues) => {
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      // We talk to /api/auth/login directly (rather than the
      // AuthContext.login helper) so we can detect the
      // requiresTotp branch and pivot to the second-factor form
      // without committing the auth context to a logged-in state.
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.requiresTotp) {
        totpForm.reset();
        switchMode('totp');
        return;
      }
      if (response.ok && body?.success && body?.user) {
        // Same effect as useAuth().login() — refresh context state.
        await checkAuth();
        navigate('/');
        return;
      }
      setErrorMessage(body?.error || 'Invalid username or password');
    } catch (error) {
      console.error('Login error:', error);
      setErrorMessage('An error occurred during login');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onTotp = async (data: TotpFormValues) => {
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const response = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify(data),
        credentials: 'include',
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.success) {
        await checkAuth();
        navigate('/');
        return;
      }
      // 401 with the "expired" message means the pending login
      // window closed — bounce back to the username/password
      // step instead of stranding the user on the TOTP form.
      if (response.status === 401 && /expired|pending/i.test(body?.error || '')) {
        switchMode('login');
        setErrorMessage(body?.error || 'Please sign in again');
        return;
      }
      setErrorMessage(body?.error || 'Invalid verification code');
    } catch (error) {
      console.error('TOTP verify error:', error);
      setErrorMessage('An error occurred verifying the code');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onReset = async (data: ResetFormValues) => {
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      const res = await apiRequest('POST', '/api/auth/request-reset', {
        body: JSON.stringify({ usernameOrEmail: data.usernameOrEmail }),
        headers: { 'Content-Type': 'application/json' },
      });
      // The server always returns the same generic message regardless of
      // whether the account exists, so we surface that text directly.
      setSuccessMessage(
        res?.message ||
          'If an account matching that username or email exists, a reset link has been sent.',
      );
      resetForm.reset();
    } catch (error) {
      console.error('Request reset error:', error);
      setErrorMessage(
        'Unable to send a reset link right now. Please try again in a few minutes.',
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500 text-black';

  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <div className="mb-6 text-center">
          <img src="/images/PG_logo_web.PNG" alt="Perfect Game Logo" className="mx-auto h-24" />
          <p className="mt-4 text-gray-600">
            {mode === 'login' ? 'Sign in to your dashboard' : 'Reset your password'}
          </p>
        </div>

        {errorMessage && (
          <div className="mb-4 rounded bg-red-100 p-3 text-red-700">{errorMessage}</div>
        )}
        {successMessage && (
          <div className="mb-4 rounded bg-green-100 p-3 text-green-700">{successMessage}</div>
        )}

        {mode === 'totp' ? (
          <form onSubmit={totpForm.handleSubmit(onTotp)} className="space-y-4">
            <p className="text-sm text-gray-600">
              Open your authenticator app and enter the current 6-digit code.
              If you've lost your device, you can use one of the recovery
              codes you saved when you set up two-factor authentication.
            </p>
            <div>
              <label htmlFor="totp-code" className="block text-sm font-medium text-gray-700">
                Verification code
              </label>
              <input
                id="totp-code"
                type="text"
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                {...totpForm.register('code')}
                className={inputClass}
              />
              {totpForm.formState.errors.code && (
                <p className="mt-1 text-sm text-red-600">
                  {totpForm.formState.errors.code.message}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {isSubmitting ? 'Verifying...' : 'Verify and sign in'}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              >
                Back to Sign In
              </button>
            </div>
          </form>
        ) : mode === 'login' ? (
          <form onSubmit={loginForm.handleSubmit(onLogin)} className="space-y-4">
            <div>
              <label htmlFor="login-username" className="block text-sm font-medium text-gray-700">
                Username
              </label>
              <input id="login-username" type="text" {...loginForm.register('username')} className={inputClass} />
              {loginForm.formState.errors.username && (
                <p className="mt-1 text-sm text-red-600">{loginForm.formState.errors.username.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input id="login-password" type="password" {...loginForm.register('password')} className={inputClass} />
              {loginForm.formState.errors.password && (
                <p className="mt-1 text-sm text-red-600">{loginForm.formState.errors.password.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {isSubmitting ? 'Signing in...' : 'Sign in'}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => switchMode('reset')}
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              >
                Reset Password
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={resetForm.handleSubmit(onReset)} className="space-y-4">
            <p className="text-sm text-gray-600">
              Enter the username or email address on your account and we'll
              send a one-time link to reset your password. The link expires
              in 30 minutes.
            </p>
            <div>
              <label htmlFor="reset-identifier" className="block text-sm font-medium text-gray-700">
                Username or email
              </label>
              <input
                id="reset-identifier"
                type="text"
                {...resetForm.register('usernameOrEmail')}
                className={inputClass}
              />
              {resetForm.formState.errors.usernameOrEmail && (
                <p className="mt-1 text-sm text-red-600">
                  {resetForm.formState.errors.usernameOrEmail.message}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {isSubmitting ? 'Sending...' : 'Send reset link'}
            </button>

            <div className="text-center">
              <button
                type="button"
                onClick={() => switchMode('login')}
                className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
              >
                Back to Sign In
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
