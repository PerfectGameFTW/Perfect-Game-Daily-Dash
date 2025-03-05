import * as React from "react";
const { useState, useEffect, useCallback } = React;
import Header from "@/components/dashboard/Header";
import StatsSummary from "@/components/dashboard/StatsSummary";
import BottomNavigation from "@/components/dashboard/BottomNavigation";
import TimeframeModal from "@/components/dashboard/TimeframeModal";
import { DateRange } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import useMobile from "@/hooks/use-mobile";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle, CheckCircle } from "lucide-react";

// Define types for sync status
interface SyncStatus {
  syncState: {
    id: string;
    syncType: string;
    status: 'running' | 'completed' | 'failed' | 'processing' | 'reset' | 'pending';
    lastSyncedAt: string;
    currentPage?: number;
    totalPages?: number;
    processedCount?: number;
    totalCount?: number;
    isComplete?: boolean;
    errorMessage?: string | null;
  };
  elapsedTime?: {
    ms: number;
    seconds: number;
    minutes: number;
  };
  isLikelyStuck?: boolean;
}

export default function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [timeframeModalOpen, setTimeframeModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [statusCheckInterval, setStatusCheckInterval] = useState<NodeJS.Timeout | null>(null);
  const isMobile = useMobile();
  const { toast } = useToast();

  const handleDateRangeChange = (newRange: DateRange, start?: Date, end?: Date) => {
    console.log('Dashboard date range change:', { 
      newRange, 
      start: start?.toISOString(), 
      end: end?.toISOString(),
      currentRange: dateRange,
      currentStart: customStartDate?.toISOString(),
      currentEnd: customEndDate?.toISOString()
    });

    queryClient.invalidateQueries();

    setDateRange(newRange);
    setCustomStartDate(start);
    setCustomEndDate(end);

    console.log('Date state updated:', {
      newDateRange: newRange,
      newStartDate: start?.toISOString(),
      newEndDate: end?.toISOString()
    });

    const queryKeys = [
      ['/api/summary', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/transactions', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/revenue-by-category', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/hourly-revenue', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/gift-card-summary', newRange, start?.toISOString(), end?.toISOString()]
    ];

    setTimeout(() => {
      queryKeys.forEach(key => {
        queryClient.invalidateQueries({ queryKey: key });
      });

      console.log('Query cache keys after invalidation:', 
        queryClient.getQueryCache().getAll().map(q => q.queryKey)
      );
    }, 10);
  };

  // Function to check sync status
  const checkSyncStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/sync-status');
      if (!response.ok) {
        throw new Error('Failed to fetch sync status');
      }
      const status = await response.json();
      setSyncStatus(status);

      // If sync is no longer running, stop the interval
      if (status.syncState?.status !== 'running' && status.syncState?.status !== 'processing') {
        if (statusCheckInterval) {
          clearInterval(statusCheckInterval);
          setStatusCheckInterval(null);
        }
        setIsSyncing(false);

        // If sync completed successfully, update the UI
        if (status.syncState?.status === 'completed') {
          toast({
            title: "Sync Completed",
            description: `Updated ${status.syncState.processedCount || 0} transactions successfully.`,
            variant: "default",
          });

          // Refresh data
          queryClient.invalidateQueries({ queryKey: ['/api/summary'] });
          queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
          queryClient.invalidateQueries({ queryKey: ['/api/revenue-by-category'] });
          queryClient.invalidateQueries({ queryKey: ['/api/hourly-revenue'] });
          queryClient.invalidateQueries({ queryKey: ['/api/gift-card-summary'] });
        }
      }
    } catch (error) {
      console.error('Error checking sync status:', error);
    }
  }, [statusCheckInterval, toast]);

  // Function to reset a stuck sync
  const handleResetSync = async () => {
    try {
      const response = await fetch('/api/reset-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to reset sync');
      }

      const result = await response.json();

      toast({
        title: "Sync Reset",
        description: result.message || "Sync has been reset successfully.",
        variant: "default",
      });

      // Check status immediately after reset
      await checkSyncStatus();

    } catch (error) {
      console.error('Error resetting sync:', error);
      toast({
        title: "Reset Failed",
        description: "There was an error resetting the sync. Please try again.",
        variant: "destructive",
      });
    }
  };

  // Enhanced sync function with force option
  const handleSync = async (force = false) => {
    setIsSyncing(true);
    try {
      const url = force ? '/api/sync?force=true' : '/api/sync';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.status === 409) {
        // Sync already in progress
        const result = await response.json();
        console.log('Sync already in progress:', result);

        let lastSyncTimeDisplay = 'unknown time';
        try {
          if (result.lastSyncTime) {
            const lastSyncDate = new Date(result.lastSyncTime);
            if (!isNaN(lastSyncDate.getTime())) {
              lastSyncTimeDisplay = lastSyncDate.toLocaleTimeString();
            }
          }
        } catch (error) {
          console.error('Error parsing lastSyncTime:', error);
        }

        toast({
          title: "Sync In Progress",
          description: `Another sync is already running. Last sync was at ${lastSyncTimeDisplay}.${result.isLikelyStuck ? ' The sync may be stuck. You can reset or force a new sync.' : ''}`,
          variant: "default",
        });

        // Start checking status periodically
        if (!statusCheckInterval) {
          const interval = setInterval(checkSyncStatus, 5000);
          setStatusCheckInterval(interval);
        }

        return;
      } else if (response.status === 408) {
        // Sync timeout
        const result = await response.json();
        toast({
          title: "Sync Timeout",
          description: result.message || "The sync process took too long. Please try again with a smaller date range.",
          variant: "destructive",
        });
        setIsSyncing(false);
        return;
      } else if (!response.ok) {
        throw new Error('Sync failed');
      }

      const result = await response.json();

      // Start checking status periodically
      if (!statusCheckInterval) {
        const interval = setInterval(checkSyncStatus, 5000);
        setStatusCheckInterval(interval);
      }

      toast({
        title: "Sync Started",
        description: "Square data sync has been initiated. You'll be notified when it completes.",
        variant: "default",
      });
    } catch (error) {
      console.error('Sync error:', error);
      toast({
        title: "Sync Failed",
        description: "There was an error syncing with Square. Please try again.",
        variant: "destructive",
      });
      setIsSyncing(false);
    }
  };

  // Check sync status when component mounts
  useEffect(() => {
    checkSyncStatus();

    // Set up interval to check status periodically
    const interval = setInterval(checkSyncStatus, 5000);
    setStatusCheckInterval(interval);

    return () => {
      if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
      }
    };
  }, []);

  // Render sync status information
  const renderSyncStatus = () => {
    if (!syncStatus) return null;

    const { syncState, elapsedTime, isLikelyStuck } = syncStatus;

    if (syncState.status === 'running' || syncState.status === 'processing') {
      // Calculate percentage if we have the total
      const progressPercent = syncState.totalCount && syncState.processedCount 
        ? Math.round((syncState.processedCount / syncState.totalCount) * 100)
        : null;

      return (
        <div className="p-4 bg-muted rounded-lg mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold flex items-center">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" /> 
              Sync in Progress
            </h3>
            <span className="text-sm text-muted-foreground">
              {elapsedTime ? `${elapsedTime.minutes}m ${elapsedTime.seconds % 60}s` : ''}
            </span>
          </div>

          {syncState.processedCount !== undefined && (
            <div className="text-sm">
              Processed {syncState.processedCount} {syncState.totalCount ? `of ${syncState.totalCount}` : ''} transactions
              {progressPercent !== null && ` (${progressPercent}%)`}
            </div>
          )}

          {isLikelyStuck && (
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center text-amber-500">
                <AlertTriangle className="w-4 h-4 mr-1" />
                <span className="text-sm">Sync may be stuck</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleResetSync}>
                  Reset Sync
                </Button>
                <Button variant="default" size="sm" onClick={() => handleSync(true)}>
                  Force New Sync
                </Button>
              </div>
            </div>
          )}
        </div>
      );
    }

    if (syncState.status === 'completed') {
      const completedTime = syncState.lastSyncedAt ? 
        new Date(syncState.lastSyncedAt).toLocaleTimeString() : 'unknown time';

      return (
        <div className="p-4 bg-muted rounded-lg mb-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center">
              <CheckCircle className="w-4 h-4 mr-2 text-green-500" /> 
              Last Sync Completed
            </h3>
            <span className="text-sm text-muted-foreground">
              {completedTime}
            </span>
          </div>

          {syncState.processedCount !== undefined && (
            <div className="text-sm">
              Processed {syncState.processedCount} transactions successfully
            </div>
          )}
        </div>
      );
    }

    if (syncState.status === 'failed') {
      return (
        <div className="p-4 bg-muted rounded-lg mb-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center text-destructive">
              <AlertTriangle className="w-4 h-4 mr-2" /> 
              Sync Failed
            </h3>
            <Button variant="outline" size="sm" onClick={() => handleSync(true)}>
              Try Again
            </Button>
          </div>

          {syncState.errorMessage && (
            <div className="text-sm text-destructive mt-1">
              {syncState.errorMessage}
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex flex-col min-h-screen w-full bg-background text-foreground pb-16 md:pb-0">
      <Header 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
        onOpenTimeframeModal={() => setTimeframeModalOpen(true)}
        onSync={handleSync}
        isSyncing={isSyncing}
      />

      <main className="flex-1 w-full overflow-y-auto px-4 py-4 space-y-6">
        <div className="w-full max-w-7xl mx-auto">
          {renderSyncStatus()}
          <StatsSummary 
            dateRange={dateRange} 
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
        </div>
      </main>

      {isMobile && <BottomNavigation />}

      <TimeframeModal 
        open={timeframeModalOpen}
        onOpenChange={setTimeframeModalOpen}
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
      />
    </div>
  );
}