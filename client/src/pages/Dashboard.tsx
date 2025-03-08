import * as React from "react";
const { useState, useEffect } = React;
import Header from "@/components/dashboard/Header";
import StatsSummary from "@/components/dashboard/StatsSummary";
import BottomNavigation from "@/components/dashboard/BottomNavigation";
import TimeframeModal from "@/components/dashboard/TimeframeModal";
import AccountDrawer from "@/components/dashboard/AccountDrawer";
import { DateRange } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import useMobile from "@/hooks/use-mobile";
import { queryClient } from "@/lib/queryClient";
import { ChartPie, TrendingUp, CreditCard, BarChart3 } from "lucide-react";
import HourlyRevenueChart from "@/components/dashboard/HourlyRevenueChart";
import RevenueByCategoryChart from "@/components/dashboard/RevenueByCategoryChart";
import GiftCardActivity from "@/components/dashboard/GiftCardActivity";

export default function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [timeframeModalOpen, setTimeframeModalOpen] = useState(false);
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
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

  // Simple sync function - no progress tracking
  const handleSync = async () => {
    if (isSyncing) return; // Prevent multiple sync requests

    setIsSyncing(true);
    try {
      const response = await fetch('/api/simple-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error('Sync failed');
      }

      toast({
        title: "Sync Started",
        description: "Square data sync has been initiated.",
        variant: "default",
      });

      // Invalidate queries after a short delay
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['/api/summary'] });
        queryClient.invalidateQueries({ queryKey: ['/api/transactions'] });
        queryClient.invalidateQueries({ queryKey: ['/api/revenue-by-category'] });
        queryClient.invalidateQueries({ queryKey: ['/api/hourly-revenue'] });
        queryClient.invalidateQueries({ queryKey: ['/api/gift-card-summary'] });
      }, 5000);
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

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview":
        return (
          <StatsSummary 
            dateRange={dateRange} 
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
        );
      case "hourly":
        return (
          <div className="space-y-8">
            <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl">
              <h2 className="text-2xl font-bold mb-4 text-white">Hourly Revenue</h2>
              <HourlyRevenueChart
                dateRange={dateRange}
                customStartDate={customStartDate}
                customEndDate={customEndDate}
              />
            </div>
          </div>
        );
      case "categories":
        return (
          <div className="space-y-8">
            <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl">
              <h2 className="text-2xl font-bold mb-4 text-white">Revenue by Category</h2>
              <RevenueByCategoryChart
                dateRange={dateRange}
                customStartDate={customStartDate}
                customEndDate={customEndDate}
              />
            </div>
          </div>
        );
      case "giftcards":
        return (
          <div className="space-y-8">
            <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl">
              <h2 className="text-2xl font-bold mb-4 text-white">Gift Card Activity</h2>
              <GiftCardActivity
                dateRange={dateRange}
                customStartDate={customStartDate}
                customEndDate={customEndDate}
              />
            </div>
          </div>
        );
      default:
        return (
          <StatsSummary 
            dateRange={dateRange} 
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
        );
    }
  };

  return (
    <div className="flex flex-col min-h-screen w-full bg-black text-foreground pb-16 md:pb-0">
      <Header 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
        onOpenTimeframeModal={() => setTimeframeModalOpen(true)}
        onSync={handleSync}
        isSyncing={isSyncing}
      />

      {/* No top navigation - using only bottom navigation */}

      <main className="flex-1 w-full overflow-y-auto px-4 py-4 space-y-6">
        <div className="w-full max-w-7xl mx-auto">
          {renderTabContent()}
        </div>
      </main>

      <BottomNavigation 
        activeTab={activeTab} 
        onTabChange={setActiveTab} 
        onAccountClick={() => setAccountDrawerOpen(true)}
      />

      <TimeframeModal 
        open={timeframeModalOpen}
        onOpenChange={setTimeframeModalOpen}
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
      />
      
      <AccountDrawer 
        open={accountDrawerOpen}
        onOpenChange={setAccountDrawerOpen}
      />
    </div>
  );
}