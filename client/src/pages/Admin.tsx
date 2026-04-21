import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import UserManagement from '@/components/admin/UserManagement';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Users, ArrowLeft, RefreshCw, Clock, CheckCircle, AlertCircle, Bell } from 'lucide-react';
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
          <button
            onClick={() => navigate('/')}
            className="flex items-center rounded-md bg-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-300"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </button>
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
          <TabsList className="mb-6 grid w-full grid-cols-1 md:w-auto md:grid-cols-3">
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
