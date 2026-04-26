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
 * Self-service account settings page (Task #179). Currently hosts the
 * "Change password" form, which posts to POST /api/auth/me/password
 * (Task #171). The endpoint verifies the current password, then revokes
 * every OTHER active session while re-persisting this one — other
 * tabs/devices get redirected to /login on their next /api/auth/me
 * poll via the global navigation guard in App.tsx.
 */

// Mirror of shared/schema.ts strongPasswordSchema. Duplicated for
// bundle-size reasons; the server is authoritative and any policy
// drift surfaces as a 400 we map inline.
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
    // Block no-op rotations — they'd revoke every other device for
    // a password that didn't actually change.
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
      // confirmPassword is a client-side guard only; don't send it.
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
      // apiRequest throws `Error('${status}: ${body}')`. Parse status
      // and body so we can map 401/400 to the right field instead of
      // showing a generic banner.
      const raw = error instanceof Error ? error.message : String(error);
      const status = raw.match(/^(\d{3}):/)?.[1];
      const bodyText = raw.replace(/^\d{3}:\s*/, '');
      let serverMsg = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as { error?: string; message?: string };
        serverMsg = parsed.error || parsed.message || bodyText;
      } catch {
        // Plain-text body — keep it.
      }

      if (status === '401') {
        form.setError('currentPassword', {
          type: 'server',
          message: serverMsg || 'Current password is incorrect',
        });
        setServerError(null);
      } else if (status === '400') {
        form.setError('newPassword', {
          type: 'server',
          message: serverMsg || 'That password does not meet our policy.',
        });
        setServerError(null);
      } else if (status === '429') {
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
