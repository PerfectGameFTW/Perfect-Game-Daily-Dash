import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, KeyRound } from 'lucide-react';

import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Self-service account settings page (Task #179).
 *
 * Currently hosts a single "Change password" form that posts to
 * POST /api/auth/me/password (Task #171). The endpoint:
 *   1. Verifies the current password before accepting a new one (so a
 *      stolen session cannot silently rotate credentials).
 *   2. Revokes every OTHER active session for this account on success
 *      while re-persisting THIS request's session — the device that
 *      initiated the change stays signed in, every other tab/device
 *      gets booted to /login on its next API call (the global
 *      navigation guard in App.tsx redirects on a null /api/auth/me
 *      response).
 *
 * The form mirrors the server's strong-password policy so users get
 * immediate feedback before submitting; the server is still the
 * authority and any policy update there will be reflected in the
 * 400 response we surface inline.
 */

// Mirror of shared/schema.ts strongPasswordSchema. Duplicated rather
// than imported from @shared so the bundle stays lean and the client
// doesn't pull the whole drizzle/zod schema graph; if the policy ever
// drifts the server will reject the value with a 400 we already
// surface inline.
const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Please enter your current password'),
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
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    // Cheap client-side sanity check. The server doesn't currently
    // forbid same-value rotations explicitly but a UX where the
    // "change" silently re-uses the same password (and revokes every
    // other device anyway) is confusing — fail fast here.
    message: 'New password must be different from your current password',
    path: ['newPassword'],
  });

type FormValues = z.infer<typeof changePasswordSchema>;

export default function AccountSettings() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const changePassword = useMutation({
    mutationFn: async (values: FormValues) => {
      // The endpoint accepts ONLY the two server-validated fields; the
      // confirmPassword is a client-side guard.
      return await apiRequest('POST', '/api/auth/me/password', {
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });
    },
    onSuccess: () => {
      toast({
        title: 'Password updated',
        description:
          'Your password has been changed. Other tabs and devices have been signed out.',
      });
      form.reset();
      setServerError(null);
    },
    onError: (error: unknown) => {
      // apiRequest throws `Error('${status}: ${body}')`. Pull the body
      // off so we can pin the wrong-current-password case to the right
      // field instead of dumping a generic banner.
      const raw = error instanceof Error ? error.message : String(error);
      const status = raw.match(/^(\d{3}):/)?.[1];
      // Body after the "<status>: " prefix may be JSON or plain text.
      const bodyText = raw.replace(/^\d{3}:\s*/, '');
      let serverMsg = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
        serverMsg = parsed.error || parsed.message || bodyText;
      } catch {
        // Not JSON — keep the raw text.
      }

      if (status === '401') {
        // Wrong current password (or session expired). The endpoint
        // returns 401 in both cases; if the user got logged out the
        // global guard will redirect them on their next /api/auth/me
        // poll, so we just surface the message inline here.
        form.setError('currentPassword', {
          type: 'server',
          message: serverMsg || 'Current password is incorrect',
        });
        setServerError(null);
      } else if (status === '400') {
        // Server-side strong-password rejection. Show against the new
        // password field so the user can correct it without hunting.
        form.setError('newPassword', {
          type: 'server',
          message: serverMsg || 'That password does not meet our policy.',
        });
        setServerError(null);
      } else if (status === '429') {
        // Hit the auth rate limiter. Distinct banner so the user knows
        // to wait rather than thinking their input was bad.
        setServerError(
          'Too many password-change attempts. Please wait a few minutes and try again.',
        );
      } else {
        setServerError(
          serverMsg || 'Something went wrong. Please try again in a moment.',
        );
      }
    },
  });

  const onSubmit = (values: FormValues) => {
    setServerError(null);
    changePassword.mutate(values);
  };

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate('/')}
            className="gap-1"
            data-testid="button-back-to-dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Button>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-foreground">
            Account settings
          </h1>
          {user?.username && (
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as <span className="font-mono">{user.username}</span>
            </p>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Change password
            </CardTitle>
            <CardDescription>
              Choose a new password for your account. Your other browser
              tabs and devices will be signed out automatically; this
              device stays signed in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              noValidate
            >
              {serverError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                  data-testid="text-change-password-error"
                >
                  {serverError}
                </div>
              )}

              <div>
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  className="mt-1"
                  data-testid="input-current-password"
                  {...form.register('currentPassword')}
                />
                {form.formState.errors.currentPassword && (
                  <p
                    className="mt-1 text-sm text-destructive"
                    data-testid="error-current-password"
                  >
                    {form.formState.errors.currentPassword.message}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  className="mt-1"
                  data-testid="input-new-password"
                  {...form.register('newPassword')}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  At least 12 characters, including a letter and a digit.
                </p>
                {form.formState.errors.newPassword && (
                  <p
                    className="mt-1 text-sm text-destructive"
                    data-testid="error-new-password"
                  >
                    {form.formState.errors.newPassword.message}
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  className="mt-1"
                  data-testid="input-confirm-password"
                  {...form.register('confirmPassword')}
                />
                {form.formState.errors.confirmPassword && (
                  <p
                    className="mt-1 text-sm text-destructive"
                    data-testid="error-confirm-password"
                  >
                    {form.formState.errors.confirmPassword.message}
                  </p>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    form.reset();
                    setServerError(null);
                  }}
                  disabled={changePassword.isPending}
                  data-testid="button-reset-form"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={changePassword.isPending}
                  data-testid="button-submit-change-password"
                >
                  {changePassword.isPending ? 'Updating...' : 'Update password'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
