import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useAuth } from '@/context/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import UserManagement from '@/components/admin/UserManagement';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Users, ArrowLeft, RefreshCw, Clock, CheckCircle, AlertCircle } from 'lucide-react';
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
    refetchInterval: 30000,
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
          <TabsList className="mb-6 grid w-full grid-cols-1 md:w-auto md:grid-cols-2">
            <TabsTrigger value="users" className="flex items-center">
              <Users className="mr-2 h-4 w-4" />
              <span>Users</span>
            </TabsTrigger>
            <TabsTrigger value="sync" className="flex items-center">
              <RefreshCw className="mr-2 h-4 w-4" />
              <span>Sync</span>
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
        </Tabs>
      </div>
    </div>
  );
}
