import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation } from 'wouter';
import { apiRequest } from '@/lib/queryClient';

// Mirrors the strong-password policy enforced by the server. Keeping the
// client-side check so users get immediate feedback before submitting.
const completeResetSchema = z
  .object({
    newPassword: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters')
      .refine((p) => /[A-Za-z]/.test(p), 'Password must contain at least one letter')
      .refine((p) => /[0-9]/.test(p), 'Password must contain at least one digit'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type FormValues = z.infer<typeof completeResetSchema>;

export default function ResetPassword() {
  const [, navigate] = useLocation();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Pull the token out of the URL once at mount. We don't echo it back
  // into the page, just hand it to the server during submit.
  const token = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return new URLSearchParams(window.location.search).get('token') || '';
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(completeResetSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const onSubmit = async (data: FormValues) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    if (!token) {
      setErrorMessage(
        'This reset link is missing its token. Request a new link from the sign-in page.',
      );
      return;
    }
    try {
      setIsSubmitting(true);
      const res = await apiRequest('POST', '/api/auth/complete-reset', {
        body: JSON.stringify({ token, newPassword: data.newPassword }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (res?.success) {
        setSuccessMessage(
          'Your password has been reset. You can now sign in with your new password.',
        );
        form.reset();
      } else {
        setErrorMessage(
          res?.error ||
            'This reset link is invalid or has expired. Please request a new one.',
        );
      }
    } catch (error: any) {
      console.error('Complete reset error:', error);
      setErrorMessage(
        error?.message ||
          'This reset link is invalid or has expired. Please request a new one.',
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
          <p className="mt-4 text-gray-600">Choose a new password</p>
        </div>

        {!token && (
          <div className="mb-4 rounded bg-yellow-100 p-3 text-yellow-800">
            This reset link is missing its token. Please use the link from
            your email exactly as we sent it.
          </div>
        )}
        {errorMessage && (
          <div className="mb-4 rounded bg-red-100 p-3 text-red-700">{errorMessage}</div>
        )}
        {successMessage && (
          <div className="mb-4 rounded bg-green-100 p-3 text-green-700">{successMessage}</div>
        )}

        {!successMessage && (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
                New Password
              </label>
              <input
                id="new-password"
                type="password"
                autoComplete="new-password"
                {...form.register('newPassword')}
                className={inputClass}
              />
              {form.formState.errors.newPassword && (
                <p className="mt-1 text-sm text-red-600">
                  {form.formState.errors.newPassword.message}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700">
                Confirm New Password
              </label>
              <input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                {...form.register('confirmPassword')}
                className={inputClass}
              />
              {form.formState.errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-600">
                  {form.formState.errors.confirmPassword.message}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !token}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:bg-blue-400"
            >
              {isSubmitting ? 'Updating...' : 'Set new password'}
            </button>
          </form>
        )}

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="text-sm text-blue-600 hover:text-blue-800 hover:underline"
          >
            Back to Sign In
          </button>
        </div>
      </div>
    </div>
  );
}
