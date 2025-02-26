import * as React from "react";
const { useState, useEffect } = React;
import Header from "@/components/dashboard/Header";
import StatsSummary from "@/components/dashboard/StatsSummary";
import BottomNavigation from "@/components/dashboard/BottomNavigation";
import TimeframeModal from "@/components/dashboard/TimeframeModal";
import { DateRange } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import useMobile from "@/hooks/use-mobile";
import { queryClient } from "@/lib/queryClient";

export default function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [timeframeModalOpen, setTimeframeModalOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
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
    
    // First, invalidate current queries
    queryClient.invalidateQueries();
    
    // Then store the new date range and dates
    setDateRange(newRange);
    setCustomStartDate(start);
    setCustomEndDate(end);
    
    // Log for debugging
    console.log('Date state updated:', {
      newDateRange: newRange,
      newStartDate: start?.toISOString(),
      newEndDate: end?.toISOString()
    });
    
    // Create an array of query keys to invalidate with the exact new parameters
    const queryKeys = [
      ['/api/summary', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/transactions', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/revenue-by-category', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/hourly-revenue', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/gift-card-summary', newRange, start?.toISOString(), end?.toISOString()]
    ];
    
    // Invalidate all relevant queries with the new query keys
    setTimeout(() => {
      // We use setTimeout to ensure React has updated the state before we refetch
      queryKeys.forEach(key => {
        queryClient.invalidateQueries({ queryKey: key });
      });
      
      // Log the current query cache state
      console.log('Query cache keys after invalidation:', 
        queryClient.getQueryCache().getAll().map(q => q.queryKey)
      );
    }, 10);
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (response.status === 409) {
        // A sync is already in progress
        const result = await response.json();
        console.log('Sync already in progress:', result);
        
        toast({
          title: "Sync In Progress",
          description: `Another sync is already running. Last sync was at ${new Date(result.lastSyncTime).toLocaleTimeString()}.`,
          variant: "default",
        });
        
        return;
      } else if (!response.ok) {
        throw new Error('Sync failed');
      }
      
      const result = await response.json();

      // Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: ['/api/summary'] });
      queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/revenue-by-category'] });
      queryClient.invalidateQueries({ queryKey: ['/api/hourly-revenue'] });
      queryClient.invalidateQueries({ queryKey: ['/api/gift-card-summary'] });
      
      toast({
        title: `${result.syncType === 'initial' ? 'Initial' : 'Incremental'} Sync Completed`,
        description: `Updated Square data (${result.syncType} sync) successfully at ${new Date(result.lastSyncTime).toLocaleTimeString()}.`,
        variant: "default",
      });
    } catch (error) {
      console.error('Sync error:', error);
      toast({
        title: "Sync Failed",
        description: "There was an error syncing with Square. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  // Initial sync is disabled to prevent automatic data loading
  // This was previously set to run automatically on dashboard load
  // useEffect(() => {
  //   const initialSync = async () => {
  //     await handleSync();
  //   };
  //   
  //   initialSync();
  // }, []);

  return (
    <div className="flex flex-col min-h-screen w-full bg-background text-foreground pb-16 md:pb-0">
      {/* Header with manual sync button */}
      <Header 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
        onOpenTimeframeModal={() => setTimeframeModalOpen(true)}
        onSync={handleSync}
        isSyncing={isSyncing}
      />

      {/* Dashboard Content */}
      <main className="flex-1 w-full overflow-y-auto px-4 py-4 space-y-6">
        {/* Stats Overview */}
        <div className="w-full max-w-7xl mx-auto">
          <StatsSummary 
            dateRange={dateRange} 
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
        </div>
      </main>
      
      {/* Bottom Navigation (only shown on mobile) */}
      {isMobile && <BottomNavigation />}
      
      {/* Timeframe Modal */}
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
