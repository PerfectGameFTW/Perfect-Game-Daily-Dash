import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import UserManagement from '@/components/admin/UserManagement';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Users, ArrowLeft, RefreshCw, Clock, CheckCircle, AlertCircle, Bell, KeyRound, Smartphone, Database, ShieldAlert, ShieldOff } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import QRCode from 'qrcode';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { formatDistanceToNow, format } from 'date-fns';

interface SyncStatusData {
  success: boolean;
  overallLastSynced: string | null;
  byType: Record<string, {
    lastSyncedAt: string | null;
    status: string;
    processedCount: number | null;
  }>;
}

const SYNC_TYPE_LABELS: Record<string, string> = {
  giftCards: 'Gift Cards',
  payments: 'Payments',
  orders: 'Orders',
  giftCardRedemptions: 'Gift Card Redemptions',
};

export default function Admin() {
  const { user, isLoading } = useAuth();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState('users');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isLoading && user?.role !== 'admin') {
      navigate('/');
    }
  }, [user, isLoading, navigate]);

  const { data: syncStatus, isLoading: syncStatusLoading } = useQuery<SyncStatusData>({
    queryKey: ['/api/sync/status'],
    refetchInterval: false,
  });

  const historicalSyncMutation = useMutation({
    mutationFn: () => apiRequest('POST', '/api/sync/historical'),
    onSuccess: () => {
      toast({
        title: 'Full catch-up sync started',
        description: 'Running in the background — this may take 10–20 minutes. The dashboard will update as data comes in.',
      });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ['/api/sync/status'] }), 5000);
    },
    onError: () => {
      toast({
        title: 'Sync failed to start',
        description: 'Check the server logs for details.',
        variant: 'destructive',
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <Spinner className="h-8 w-8" />
          <p className="mt-2 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user || user.role !== 'admin') {
    return null;
  }

  const formatSyncTime = (ts: string | null) => {
    if (!ts) return 'Never';
    const d = new Date(ts);
    return `${formatDistanceToNow(d, { addSuffix: true })} (${format(d, 'MMM d, yyyy h:mm a')})`;
  };

  const staleDays = (ts: string | null) => {
    if (!ts) return null;
    return Math.floor((Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container mx-auto px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center">
            <ShieldCheck className="mr-2 h-8 w-8 text-purple-600" />
            <h1 className="text-3xl font-bold text-gray-900">Admin Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate('/admin/mcp-audit')}
              className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              <Database className="mr-2 h-4 w-4" />
              SQL Query History
            </button>
            <button
              onClick={() => navigate('/admin/sync-audit')}
              className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              <Database className="mr-2 h-4 w-4" />
              Backfill Audit
            </button>
            <button
              onClick={() => navigate('/')}
              className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Dashboard
            </button>
          </div>
        </div>

        <Card className="mb-8">
          <CardHeader className="pb-3">
            <CardTitle>Welcome, {user.username}</CardTitle>
            <CardDescription>
              Admin panel gives you access to user management and data sync controls.
            </CardDescription>
          </CardHeader>
        </Card>

        <Tabs defaultValue="users" value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 grid w-full grid-cols-1 md:w-auto md:grid-cols-4">
            <TabsTrigger value="users" className="flex items-center">
              <Users className="mr-2 h-4 w-4" />
              <span>Users</span>
            </TabsTrigger>
            <TabsTrigger value="sync" className="flex items-center">
              <RefreshCw className="mr-2 h-4 w-4" />
              <span>Sync</span>
            </TabsTrigger>
            <TabsTrigger value="alerts" className="flex items-center">
              <Bell className="mr-2 h-4 w-4" />
              <span>Alerts</span>
            </TabsTrigger>
            <TabsTrigger value="security" className="flex items-center">
              <KeyRound className="mr-2 h-4 w-4" />
              <span>Security</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-0">
            <Card>
              <CardContent className="pt-6">
                <UserManagement />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="sync" className="mt-0 space-y-6">
            {/* Sync status card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  Data Freshness
                </CardTitle>
                <CardDescription>
                  A nightly sync runs automatically at 3 AM Eastern Time. This table shows when each data type was last updated.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {syncStatusLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Spinner className="h-4 w-4" />
                    <span>Loading sync status...</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(syncStatus?.byType ?? {}).map(([type, info]) => {
                      const days = staleDays(info.lastSyncedAt);
                      const isStale = days !== null && days > 1;
                      return (
                        <div key={type} className="flex items-center justify-between rounded-lg border p-3">
                          <div className="flex items-center gap-3">
                            {isStale ? (
                              <AlertCircle className="h-4 w-4 text-amber-500" />
                            ) : (
                              <CheckCircle className="h-4 w-4 text-green-500" />
                            )}
                            <div>
                              <p className="font-medium text-sm">{SYNC_TYPE_LABELS[type] ?? type}</p>
                              <p className="text-xs text-muted-foreground">
                                {formatSyncTime(info.lastSyncedAt)}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                              isStale
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-green-100 text-green-700'
                            }`}>
                              {isStale ? `${days}d stale` : 'Current'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(syncStatus?.byType ?? {}).length === 0 && (
                      <p className="text-sm text-muted-foreground">No sync history found. Run a sync to get started.</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Historical catch-up card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-5 w-5 text-muted-foreground" />
                  Full Catch-up Sync
                </CardTitle>
                <CardDescription>
                  Use this when months of data are missing — for example, after the app has been offline or a sync type has fallen far behind. It re-syncs orders, payments, and gift cards in monthly chunks from the past 2 years through today, then runs the gift card activation repair. This runs entirely in the background and may take 10–20 minutes.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground max-w-md">
                  The nightly automatic sync handles day-to-day freshness. Only run this if you notice large gaps in the dashboard data.
                </p>
                <Button
                  onClick={() => historicalSyncMutation.mutate()}
                  disabled={historicalSyncMutation.isPending}
                  className="shrink-0 gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${historicalSyncMutation.isPending ? 'animate-spin' : ''}`} />
                  {historicalSyncMutation.isPending ? 'Starting...' : 'Start Full Catch-up Sync'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="alerts" className="mt-0 space-y-6">
            <SquareRateLimitAlertSettingsCard />
          </TabsContent>

          <TabsContent value="security" className="mt-0 space-y-6">
            <TwoFactorAuthCard />
            <AdminSecurityOverviewCard />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

interface AlertSettingsResponse {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
  webhookConfigured: boolean;
}

const ALERT_SETTINGS_KEY = ['/api/admin/alerts/square-rate-limit'] as const;

/**
 * Settings card for the in-process Square 429 alerter. Lets on-call
 * tune sensitivity (count + rolling window) and quiet-period without
 * a deploy. The webhook URL itself stays in the deployment env and
 * is intentionally never round-tripped through the UI; we only show
 * a "configured / not configured" indicator.
 */
function SquareRateLimitAlertSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery<AlertSettingsResponse>({
    queryKey: ALERT_SETTINGS_KEY,
  });

  // Local form state — the inputs are minute-based to match how
  // operators reason about quiet hours, but the API speaks ms.
  const [threshold, setThreshold] = useState('');
  const [windowMin, setWindowMin] = useState('');
  const [cooldownMin, setCooldownMin] = useState('');

  useEffect(() => {
    if (!data) return;
    setThreshold(String(data.threshold));
    setWindowMin(String(Math.round(data.windowMs / 60000)));
    setCooldownMin(String(Math.round(data.cooldownMs / 60000)));
  }, [data]);

  const mutation = useMutation({
    mutationFn: (body: { threshold: number; windowMs: number; cooldownMs: number }) =>
      apiRequest('PUT', '/api/admin/alerts/square-rate-limit', {
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      toast({ title: 'Alert thresholds updated', description: 'Changes are live immediately.' });
      queryClient.invalidateQueries({ queryKey: ALERT_SETTINGS_KEY });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not save alert settings.';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = Number.parseInt(threshold, 10);
    const w = Number.parseInt(windowMin, 10);
    const c = Number.parseInt(cooldownMin, 10);
    if (!Number.isFinite(t) || !Number.isFinite(w) || !Number.isFinite(c)) {
      toast({
        title: 'Invalid values',
        description: 'All fields must be whole numbers.',
        variant: 'destructive',
      });
      return;
    }
    mutation.mutate({
      threshold: t,
      windowMs: w * 60_000,
      cooldownMs: c * 60_000,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-muted-foreground" />
          Square Rate-Limit (HTTP 429) Alert
        </CardTitle>
        <CardDescription>
          When Square throttles us, the server fires a webhook alert if enough 429s land in the
          rolling window. Use these knobs to quiet noisy periods or tighten sensitivity after an
          incident — changes take effect immediately, no restart required.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading current settings...</span>
          </div>
        ) : isError || !data ? (
          // Surface load failures explicitly (e.g. missing app_settings
          // table on an env that hasn't bootstrapped yet) so admins
          // see an actionable error instead of an indefinite spinner.
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Could not load alert settings.</p>
                <p className="text-xs opacity-80">
                  {error instanceof Error ? error.message : 'Please try again.'}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" onClick={() => refetch()} className="gap-2">
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4 max-w-md">
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
              Webhook URL:{' '}
              <span className={data.webhookConfigured ? 'font-medium text-green-700' : 'font-medium text-amber-700'}>
                {data.webhookConfigured ? 'configured' : 'not configured (alerts will not fire)'}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="alert-threshold">Threshold (events)</Label>
                <Input
                  id="alert-threshold"
                  type="number"
                  min={1}
                  max={1000}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-window">Window (minutes)</Label>
                <Input
                  id="alert-window"
                  type="number"
                  min={1}
                  max={1440}
                  value={windowMin}
                  onChange={(e) => setWindowMin(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-cooldown">Cooldown (minutes)</Label>
                <Input
                  id="alert-cooldown"
                  type="number"
                  min={1}
                  max={1440}
                  value={cooldownMin}
                  onChange={(e) => setCooldownMin(e.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Fires when at least <strong>threshold</strong> Square 429s land within the rolling{' '}
              <strong>window</strong>; then waits <strong>cooldown</strong> before firing again.
            </p>
            <div className="flex justify-end">
              <Button type="submit" disabled={mutation.isPending} className="gap-2">
                {mutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                {mutation.isPending ? 'Saving...' : 'Save alert thresholds'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP) — Task #56
// ---------------------------------------------------------------------------
//
// Self-service enrollment screen for the signed-in admin. Three states:
//   1. Not enrolled            — show "Enable 2FA" button.
//   2. Pending enrollment      — show QR + secret + 6-digit verification.
//   3. Enabled                 — show recovery-code count + "Disable 2FA"
//      button (re-prompts for the current password).
// Recovery codes are only shown once, immediately after a successful
// verification — never re-fetched, never persisted client-side beyond
// the lifetime of the current page render.

interface TotpStatusResponse {
  enabled: boolean;
  pendingEnrollment: boolean;
  recoveryCodesRemaining: number;
}

interface TotpEnrollResponse {
  secret: string;
  otpauthUrl: string;
}

const TOTP_STATUS_KEY = ['/api/auth/totp/status'] as const;

function TwoFactorAuthCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery<TotpStatusResponse>({
    queryKey: TOTP_STATUS_KEY,
  });

  const [enrollment, setEnrollment] = useState<TotpEnrollResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');

  // Render the QR whenever a fresh otpauth URL arrives. We do this in
  // an effect (rather than inline) so the (sync) qrcode call doesn't
  // run on every re-render.
  useEffect(() => {
    if (!enrollment) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(enrollment.otpauthUrl, { width: 240, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollment]);

  const enrollMutation = useMutation({
    mutationFn: () =>
      apiRequest('POST', '/api/auth/totp/enroll', { body: '{}' }) as Promise<TotpEnrollResponse>,
    onSuccess: (data) => {
      setEnrollment(data);
      setRecoveryCodes(null);
      setVerifyCode('');
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not start enrollment.';
      toast({ title: 'Enrollment failed', description: message, variant: 'destructive' });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (code: string) =>
      apiRequest('POST', '/api/auth/totp/enroll/verify', {
        body: JSON.stringify({ code }),
      }) as Promise<{ success: boolean; recoveryCodes: string[] }>,
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setEnrollment(null);
      setQrDataUrl(null);
      setVerifyCode('');
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({ title: 'Two-factor authentication enabled', description: 'Save your recovery codes — they will not be shown again.' });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'That code did not match.';
      toast({ title: 'Verification failed', description: message, variant: 'destructive' });
    },
  });

  const disableMutation = useMutation({
    mutationFn: (password: string) =>
      apiRequest('POST', '/api/auth/totp/disable', {
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      setDisablePassword('');
      setRecoveryCodes(null);
      queryClient.invalidateQueries({ queryKey: TOTP_STATUS_KEY });
      toast({ title: 'Two-factor authentication disabled' });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not disable 2FA.';
      toast({ title: 'Disable failed', description: message, variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-muted-foreground" />
          Two-Factor Authentication (TOTP)
        </CardTitle>
        <CardDescription>
          Add a 6-digit one-time code from an authenticator app (Google
          Authenticator, 1Password, Authy, etc.) to your sign-in. Even
          if your password leaks, an attacker still needs your phone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Checking 2FA status...</span>
          </div>
        ) : (
          <>
            {/* Status banner */}
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                status?.enabled
                  ? 'border-green-200 bg-green-50 text-green-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {status?.enabled ? (
                <>
                  <strong>Enabled.</strong> You have{' '}
                  {status.recoveryCodesRemaining} recovery code
                  {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining.
                </>
              ) : (
                <>
                  <strong>Not enabled.</strong> Your account is currently
                  protected by your password only.
                </>
              )}
            </div>

            {/* Freshly-generated recovery codes */}
            {recoveryCodes && (
              <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm font-semibold text-blue-900">
                  Save these recovery codes somewhere safe:
                </p>
                <p className="text-xs text-blue-900/80">
                  Each code works exactly once. Use them to sign in if you
                  lose access to your authenticator. They will not be shown
                  again.
                </p>
                <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm text-blue-900">
                  {recoveryCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Pending enrollment: show QR + verify form */}
            {enrollment ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Scan this QR code with your authenticator app, then enter
                  the 6-digit code it shows to finish setup.
                </p>
                <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt="TOTP QR code"
                      className="h-60 w-60 rounded border"
                    />
                  ) : (
                    <div className="flex h-60 w-60 items-center justify-center rounded border text-sm text-muted-foreground">
                      <Spinner className="h-4 w-4" />
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label className="text-xs">Or enter this secret manually:</Label>
                    <div className="rounded bg-muted px-2 py-1 font-mono text-xs">
                      {enrollment.secret}
                    </div>
                  </div>
                </div>
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="totp-enroll-code">6-digit code</Label>
                  <Input
                    id="totp-enroll-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => verifyMutation.mutate(verifyCode)}
                    disabled={verifyMutation.isPending || verifyCode.length < 6}
                    className="gap-2"
                  >
                    {verifyMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                    {verifyMutation.isPending ? 'Verifying...' : 'Verify and enable'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEnrollment(null);
                      setVerifyCode('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : status?.enabled ? (
              // Enabled state: offer to disable (after password re-check)
              // or to re-enroll (which replaces the secret only after the
              // new code is verified, so the old factor stays live until
              // then).
              <div className="space-y-3">
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="totp-disable-pw">
                    Confirm your password to disable
                  </Label>
                  <Input
                    id="totp-disable-pw"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => disableMutation.mutate(disablePassword)}
                    disabled={disableMutation.isPending || !disablePassword}
                    className="gap-2"
                  >
                    {disableMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                    Disable 2FA
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => enrollMutation.mutate()}
                    disabled={enrollMutation.isPending}
                    className="gap-2"
                  >
                    {enrollMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                    Re-enroll device
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                onClick={() => enrollMutation.mutate()}
                disabled={enrollMutation.isPending}
                className="gap-2"
              >
                {enrollMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                Enable 2FA
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface AdminSecurityOverviewRow {
  id: number;
  username: string;
  role: string;
  totpEnabled: boolean;
  recoveryCodesRemaining: number;
  totpLastUsedAt: string | null;
}

interface RequireTwoFactorResponse {
  enabled: boolean;
}

const SECURITY_OVERVIEW_KEY = ['/api/auth/admin/security/overview'] as const;
const REQUIRE_2FA_KEY = ['/api/auth/admin/security/require-2fa'] as const;

/**
 * Admin-only Security overview (Task #100). Renders one row per account
 * with its 2FA state, recovery codes remaining, and last-used timestamp,
 * a deployment-wide toggle to require 2FA on every admin login, and a
 * per-row "Disable 2FA" button for other admins (re-checks the calling
 * admin's own password and is server-side audit-logged).
 */
function AdminSecurityOverviewCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [disableTarget, setDisableTarget] = useState<AdminSecurityOverviewRow | null>(null);
  const [disablePassword, setDisablePassword] = useState('');

  const {
    data: rows,
    isLoading: rowsLoading,
    isError: rowsError,
    error: rowsErrorObj,
    refetch: refetchRows,
  } = useQuery<AdminSecurityOverviewRow[]>({
    queryKey: SECURITY_OVERVIEW_KEY,
  });
  const {
    data: requireSetting,
    isLoading: settingLoading,
    isError: settingError,
    error: settingErrorObj,
    refetch: refetchSetting,
  } = useQuery<RequireTwoFactorResponse>({
    queryKey: REQUIRE_2FA_KEY,
  });

  const requireMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest('PUT', '/api/auth/admin/security/require-2fa', {
        body: JSON.stringify({ enabled }),
      }) as Promise<RequireTwoFactorResponse>,
    onSuccess: (data) => {
      queryClient.setQueryData(REQUIRE_2FA_KEY, data);
      toast({
        title: data.enabled
          ? 'Two-factor authentication is now required for all admins'
          : 'Two-factor authentication is no longer required',
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not update setting.';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    },
  });

  const disableMutation = useMutation({
    mutationFn: ({ targetId, password }: { targetId: number; password: string }) =>
      apiRequest('POST', `/api/auth/admin/security/users/${targetId}/disable-totp`, {
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SECURITY_OVERVIEW_KEY });
      setDisableTarget(null);
      setDisablePassword('');
      toast({ title: 'Two-factor authentication disabled for that account' });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Could not disable 2FA.';
      toast({ title: 'Disable failed', description: message, variant: 'destructive' });
    },
  });

  const formatLastUsed = (ts: string | null) => {
    if (!ts) return 'Never';
    const d = new Date(ts);
    return `${formatDistanceToNow(d, { addSuffix: true })}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          Admin 2FA Overview
        </CardTitle>
        <CardDescription>
          See which accounts have a second factor enrolled and require
          every admin to use one. Disabling another admin&apos;s 2FA is
          recorded in the security audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-start justify-between gap-4 rounded-md border p-4">
          <div className="space-y-1">
            <Label htmlFor="require-2fa-toggle" className="text-sm font-medium">
              Require 2FA for all admin logins
            </Label>
            <p className="text-xs text-muted-foreground">
              When on, any admin who hasn&apos;t enrolled an authenticator
              app will be forced through enrollment on their next sign-in
              before they can use the dashboard.
            </p>
          </div>
          {settingLoading ? (
            <Spinner className="h-4 w-4" />
          ) : settingError ? (
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs text-destructive">
                {settingErrorObj instanceof Error
                  ? settingErrorObj.message
                  : 'Failed to load setting.'}
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => refetchSetting()}>
                Retry
              </Button>
            </div>
          ) : (
            <Switch
              id="require-2fa-toggle"
              checked={Boolean(requireSetting?.enabled)}
              disabled={requireMutation.isPending}
              onCheckedChange={(checked) => requireMutation.mutate(checked)}
            />
          )}
        </div>

        {rowsError ? (
          <div className="flex items-center justify-between rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span>
                {rowsErrorObj instanceof Error
                  ? rowsErrorObj.message
                  : 'Failed to load accounts.'}
              </span>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => refetchRows()}>
              Retry
            </Button>
          </div>
        ) : rowsLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="h-4 w-4" />
            <span>Loading accounts...</span>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">2FA</th>
                  <th className="px-3 py-2">Recovery codes</th>
                  <th className="px-3 py-2">Last used</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((row) => {
                  const isSelf = user?.id === row.id;
                  // Server already restricts the disable endpoint to
                  // admin targets; mirror that in the UI so the button
                  // never appears for a row the API would refuse.
                  const canDisable = !isSelf && row.totpEnabled && row.role === 'admin';
                  return (
                    <tr key={row.id} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.username}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${
                          row.role === 'admin'
                            ? 'bg-purple-100 text-purple-800'
                            : 'bg-gray-100 text-gray-700'
                        }`}>
                          {row.role}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {row.totpEnabled ? (
                          <span className="inline-flex items-center gap-1 text-green-700">
                            <ShieldCheck className="h-4 w-4" /> Enabled
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-700">
                            <ShieldAlert className="h-4 w-4" /> Not enabled
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.totpEnabled ? row.recoveryCodesRemaining : '—'}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {row.totpEnabled ? formatLastUsed(row.totpLastUsedAt) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {canDisable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-1"
                            onClick={() => {
                              setDisableTarget(row);
                              setDisablePassword('');
                            }}
                          >
                            <ShieldOff className="h-3.5 w-3.5" />
                            Disable
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {(rows ?? []).length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-center text-muted-foreground" colSpan={6}>
                      No accounts found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {disableTarget && (
          <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm">
              Disable 2FA for <strong>{disableTarget.username}</strong>?
              They&apos;ll be able to sign in with just their password
              until they re-enroll. This action is logged.
            </p>
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="admin-disable-pw" className="text-xs">
                Confirm your password
              </Label>
              <Input
                id="admin-disable-pw"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={disableMutation.isPending || !disablePassword}
                onClick={() =>
                  disableMutation.mutate({
                    targetId: disableTarget.id,
                    password: disablePassword,
                  })
                }
                className="gap-2"
              >
                {disableMutation.isPending ? <Spinner className="h-4 w-4" /> : null}
                Disable 2FA
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDisableTarget(null);
                  setDisablePassword('');
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
