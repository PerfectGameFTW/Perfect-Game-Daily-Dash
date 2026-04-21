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

const resetSchema = z
  .object({
    username: z.string().min(3, 'Username must be at least 3 characters'),
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .refine((p) => /[A-Za-z]/.test(p), 'Password must contain at least one letter')
      .refine((p) => /[0-9]/.test(p), 'Password must contain at least one digit'),
    confirmPassword: z.string().min(12, 'Password must be at least 12 characters'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type LoginFormValues = z.infer<typeof loginSchema>;
type ResetFormValues = z.infer<typeof resetSchema>;

export default function Login() {
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const resetForm = useForm<ResetFormValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { username: '', newPassword: '', confirmPassword: '' },
  });

  const switchMode = (next: 'login' | 'reset') => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setMode(next);
  };

  const onLogin = async (data: LoginFormValues) => {
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      const success = await login(data.username, data.password);
      if (success) {
        navigate('/');
      } else {
        setErrorMessage('Invalid username or password');
      }
    } catch (error) {
      console.error('Login error:', error);
      setErrorMessage('An error occurred during login');
    } finally {
      setIsSubmitting(false);
    }
  };

  const onReset = async (data: ResetFormValues) => {
    try {
      setIsSubmitting(true);
      setErrorMessage(null);
      setSuccessMessage(null);
      const res = await apiRequest('POST', '/api/auth/reset-password', {
        body: JSON.stringify({ username: data.username, newPassword: data.newPassword }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (res?.success) {
        setSuccessMessage('Password reset successfully. You can now sign in with your new password.');
        resetForm.reset();
      } else {
        setErrorMessage('Unable to reset password. Please check your username and try again.');
      }
    } catch (error) {
      console.error('Reset password error:', error);
      setErrorMessage('Unable to reset password. Please check your username and try again.');
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

        {mode === 'login' ? (
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
            <div>
              <label htmlFor="reset-username" className="block text-sm font-medium text-gray-700">
                Username
              </label>
              <input id="reset-username" type="text" {...resetForm.register('username')} className={inputClass} />
              {resetForm.formState.errors.username && (
                <p className="mt-1 text-sm text-red-600">{resetForm.formState.errors.username.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="reset-new-password" className="block text-sm font-medium text-gray-700">
                New Password
              </label>
              <input
                id="reset-new-password"
                type="password"
                {...resetForm.register('newPassword')}
                className={inputClass}
              />
              {resetForm.formState.errors.newPassword && (
                <p className="mt-1 text-sm text-red-600">{resetForm.formState.errors.newPassword.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="reset-confirm-password" className="block text-sm font-medium text-gray-700">
                Confirm New Password
              </label>
              <input
                id="reset-confirm-password"
                type="password"
                {...resetForm.register('confirmPassword')}
                className={inputClass}
              />
              {resetForm.formState.errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-600">{resetForm.formState.errors.confirmPassword.message}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {isSubmitting ? 'Resetting...' : 'Reset Password'}
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
