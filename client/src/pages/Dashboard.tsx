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
import { ChartPie, TrendingUp, CreditCard, BarChart3 } from "lucide-react";
import HourlyRevenueChart from "@/components/dashboard/HourlyRevenueChart";
import RevenueByCategoryChart from "@/components/dashboard/RevenueByCategoryChart";
import GiftCardActivity from "@/components/dashboard/GiftCardActivity";

export default function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [timeframeModalOpen, setTimeframeModalOpen] = useState(false);
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
    <div className="flex flex-col min-h-screen w-full bg-gradient-to-br from-gray-900 via-indigo-950 to-black text-foreground pb-16 md:pb-0">
      <Header 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
        onOpenTimeframeModal={() => setTimeframeModalOpen(true)}
        onSync={handleSync}
        isSyncing={isSyncing}
      />

      {/* Navigation Tabs */}
      <div className="w-full px-4 pt-4">
        <div className="w-full max-w-7xl mx-auto">
          <div className="flex space-x-2 overflow-x-auto pb-2 md:justify-center">
            <button
              onClick={() => setActiveTab("overview")}
              className={`px-4 py-2 rounded-lg flex items-center space-x-2 whitespace-nowrap transition-all ${
                activeTab === "overview" 
                  ? "bg-primary text-white font-medium shadow-lg shadow-primary/30" 
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >
              <BarChart3 className="h-4 w-4" />
              <span>Overview</span>
            </button>
            <button
              onClick={() => setActiveTab("hourly")}
              className={`px-4 py-2 rounded-lg flex items-center space-x-2 whitespace-nowrap transition-all ${
                activeTab === "hourly" 
                  ? "bg-primary text-white font-medium shadow-lg shadow-primary/30" 
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >
              <TrendingUp className="h-4 w-4" />
              <span>Hourly</span>
            </button>
            <button
              onClick={() => setActiveTab("categories")}
              className={`px-4 py-2 rounded-lg flex items-center space-x-2 whitespace-nowrap transition-all ${
                activeTab === "categories" 
                  ? "bg-primary text-white font-medium shadow-lg shadow-primary/30" 
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >
              <ChartPie className="h-4 w-4" />
              <span>Categories</span>
            </button>
            <button
              onClick={() => setActiveTab("giftcards")}
              className={`px-4 py-2 rounded-lg flex items-center space-x-2 whitespace-nowrap transition-all ${
                activeTab === "giftcards" 
                  ? "bg-primary text-white font-medium shadow-lg shadow-primary/30" 
                  : "bg-white/5 hover:bg-white/10 text-white/70"
              }`}
            >
              <CreditCard className="h-4 w-4" />
              <span>Gift Cards</span>
            </button>
          </div>
        </div>
      </div>

      <main className="flex-1 w-full overflow-y-auto px-4 py-4 space-y-6">
        <div className="w-full max-w-7xl mx-auto">
          {renderTabContent()}
        </div>
      </main>

      {isMobile && <BottomNavigation activeTab={activeTab} onTabChange={setActiveTab} />}

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