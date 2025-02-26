import { useState, useEffect } from "react";
import Header from "@/components/dashboard/Header";
import StatsSummary from "@/components/dashboard/StatsSummary";
import BottomNavigation from "@/components/dashboard/BottomNavigation";
import TimeframeModal from "@/components/dashboard/TimeframeModal";
import RevenueByCategoryChart from "@/components/dashboard/RevenueByCategoryChart";
import HourlyRevenueChart from "@/components/dashboard/HourlyRevenueChart";
import RecentTransactionsTable from "@/components/dashboard/RecentTransactionsTable";
import GiftCardActivity from "@/components/dashboard/GiftCardActivity";
import { DateRange } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import useMobile from "@/hooks/use-mobile";
import { ArrowUpRight, CalendarDays, LayoutGrid, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
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
    setDateRange(newRange);
    if (newRange === "custom") {
      setCustomStartDate(start);
      setCustomEndDate(end);
    } else {
      setCustomStartDate(undefined);
      setCustomEndDate(undefined);
    }
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
      
      if (!response.ok) {
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
        title: "Sync Completed",
        description: `Updated Square data successfully.`,
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

  // Initial sync when dashboard loads
  useEffect(() => {
    handleSync();
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground pb-16 md:pb-0">
      {/* Header */}
      <Header 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
        onOpenTimeframeModal={() => setTimeframeModalOpen(true)}
      />

      {/* Dashboard Content */}
      <main className="flex-1 overflow-y-auto px-4 py-4 space-y-6 max-w-7xl mx-auto">
        {/* Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
          <div className="inline-flex items-center gap-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setTimeframeModalOpen(true)}
              className="flex items-center gap-1"
            >
              <CalendarDays size={16} />
              <span>Timeframe</span>
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleSync}
              disabled={isSyncing}
              className="flex items-center gap-1"
            >
              <RefreshCw size={16} className={isSyncing ? "animate-spin" : ""} />
              <span>{isSyncing ? "Syncing..." : "Sync"}</span>
            </Button>
          </div>
          <div className="inline-flex items-center gap-2">
            <Button 
              variant="secondary" 
              size="sm" 
              className="flex items-center gap-1"
            >
              <LayoutGrid size={16} />
              <span>Dashboard</span>
            </Button>
            <Button 
              variant="default" 
              size="sm"
              className="flex items-center gap-1"
            >
              <span>Square Portal</span>
              <ArrowUpRight size={16} />
            </Button>
          </div>
        </div>

        {/* Hourly Revenue Chart - Only chart above Metrics */}
        <HourlyRevenueChart 
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
        
        {/* Stats Overview */}
        <StatsSummary 
          dateRange={dateRange} 
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
        
        {/* Tabbed Content for Transactions and Gift Cards */}
        <Tabs defaultValue="transactions" className="w-full">
          <TabsList className="bg-muted border border-border w-full md:w-auto">
            <TabsTrigger value="transactions" className="data-[state=active]:bg-background flex-1 md:flex-none">
              Recent Transactions
            </TabsTrigger>
            <TabsTrigger value="giftcards" className="data-[state=active]:bg-background flex-1 md:flex-none">
              Gift Card Activity
            </TabsTrigger>
          </TabsList>
          <TabsContent value="transactions" className="mt-3">
            <RecentTransactionsTable 
              dateRange={dateRange}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
            />
          </TabsContent>
          <TabsContent value="giftcards" className="mt-3">
            <GiftCardActivity 
              dateRange={dateRange}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
            />
          </TabsContent>
        </Tabs>
      </main>
      
      {/* Bottom Navigation (only shown on mobile) */}
      {isMobile && <BottomNavigation />}
      
      {/* Timeframe Modal */}
      <TimeframeModal 
        open={timeframeModalOpen}
        onOpenChange={setTimeframeModalOpen}
        dateRange={dateRange}
        onDateRangeChange={handleDateRangeChange}
      />
    </div>
  );
}
