import React from 'react';
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useQuery } from "@tanstack/react-query";
import { fetchSyncStatus } from "@/lib/squareApi";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

const SyncProgressBar: React.FC = () => {
  // Query for sync status with frequent refresh
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: fetchSyncStatus,
    refetchInterval: 3000, // Refresh every 3 seconds
    retry: true,
    retryDelay: 1000,
  });

  if (isLoading) {
    return (
      <Card className="shadow-md">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Sync Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            <span className="text-sm">Loading sync status...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="shadow-md border-red-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center">
            <AlertCircle className="h-4 w-4 mr-2 text-red-500" />
            Sync Status Error
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-red-500 mb-2">
            Failed to load sync status
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            className="h-7 px-2 text-xs"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-3 w-3 mr-1" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return null;
  }

  // Calculate progress percentage
  const progress = data.progress.totalItems > 0 
    ? Math.floor((data.progress.processedItems / data.progress.totalItems) * 100) 
    : 0;

  // Format dates
  const formatDateTime = (dateString: string): string => {
    const date = new Date(dateString);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  // Last sync time
  const lastSyncTime = data.lastSyncTime 
    ? formatDateTime(data.lastSyncTime) 
    : 'Never';

  // Generate stage label
  const stageLabel = () => {
    switch(data.progress.stage) {
      case 'idle': return 'Ready';
      case 'fetching': return 'Fetching Data';
      case 'processing': return 'Processing Transactions';
      case 'gift-cards': return 'Processing Gift Cards';
      case 'complete': return 'Complete';
      default: return 'Unknown';
    }
  };

  // Time remaining estimate
  const getTimeRemaining = (): string => {
    if (!data.progress.estimatedEndTime) return 'Calculating...';
    
    const now = new Date();
    const endTime = new Date(data.progress.estimatedEndTime);
    const diffMs = endTime.getTime() - now.getTime();
    
    if (diffMs <= 0) return 'Almost done...';
    
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffSeconds = Math.floor((diffMs % 60000) / 1000);
    
    if (diffMinutes > 0) {
      return `~${diffMinutes} min ${diffSeconds} sec remaining`;
    } else {
      return `~${diffSeconds} sec remaining`;
    }
  };

  // Started time ago
  const getStartedTimeAgo = (): string => {
    const now = new Date();
    const startTime = new Date(data.progress.startTime);
    const diffMs = now.getTime() - startTime.getTime();
    
    if (diffMs < 0) return 'Just now';
    
    const diffMinutes = Math.floor(diffMs / 60000);
    const diffSeconds = Math.floor((diffMs % 60000) / 1000);
    
    if (diffMinutes > 0) {
      return `${diffMinutes} min ${diffSeconds} sec ago`;
    } else {
      return `${diffSeconds} sec ago`;
    }
  };

  if (data.isRunning) {
    // Sync is in progress - show progress bar
    return (
      <Card className="shadow-md border border-blue-100 bg-blue-50/10">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center">
            <Loader2 className="h-4 w-4 mr-2 animate-spin text-blue-500" />
            Square Sync in Progress
          </CardTitle>
          <Badge variant={data.progress.error ? "destructive" : "secondary"}>
            {data.progress.error ? "Error" : stageLabel()}
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{data.progress.processedItems.toLocaleString()} of {data.progress.totalItems > 0 ? data.progress.totalItems.toLocaleString() : '?'} items</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-2" />
            
            {data.progress.error ? (
              <div className="text-xs text-red-500 mt-1">
                Error: {data.progress.error}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-2 text-xs text-muted-foreground mt-1">
                <div>Started: <span className="font-medium">{getStartedTimeAgo()}</span></div>
                <div>Remaining: <span className="font-medium">{getTimeRemaining()}</span></div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Check if lastSyncTime is valid (not epoch time)
  const hasValidSyncTime = new Date(data.lastSyncTime).getTime() > 1000;
  
  // Not running - show last sync time and sync button
  return (
    <Card className="shadow-md">
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Square Sync Status</CardTitle>
        <Badge variant="outline" className="bg-green-50">
          <CheckCircle2 className="h-3 w-3 mr-1" /> Ready
        </Badge>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col space-y-2">
          <div className="text-xs text-muted-foreground">
            {hasValidSyncTime ? (
              <>Last sync completed: {lastSyncTime}</>
            ) : (
              <>No sync has been completed yet</>
            )}
          </div>
          
          {/* Display progress from previous sync if available */}
          {data.progress.stage === 'complete' && data.progress.totalItems > 0 && (
            <div className="text-xs">
              Last sync processed {data.progress.processedItems.toLocaleString()} records
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default SyncProgressBar;