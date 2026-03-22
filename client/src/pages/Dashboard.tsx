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
    queryClient.invalidateQueries();

    setDateRange(newRange);
    setCustomStartDate(start);
    setCustomEndDate(end);

    const queryKeys = [
      ['/api/summary', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/transactions', newRange, start?.toISOString(), end?.toISOString()],
      ['/api/gift-card-summary', newRange, start?.toISOString(), end?.toISOString()]
    ];

    setTimeout(() => {
      queryKeys.forEach(key => {
        queryClient.invalidateQueries({ queryKey: key });
      });

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
      case "giftcards":
        return (
          <div className="space-y-8">
            <GiftCardActivity
              dateRange={dateRange}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
            />
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
    <div className="flex flex-col min-h-screen w-full bg-background text-foreground pb-16 md:pb-20">
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