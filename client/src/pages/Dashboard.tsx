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
import ItemsPerformance from "@/components/dashboard/ItemsPerformance";

export default function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [timeframeModalOpen, setTimeframeModalOpen] = useState(false);
  const [accountDrawerOpen, setAccountDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  // Track whether the user has changed the date range from the initial
  // "today" default. The Items tab is most useful over a multi-day window,
  // so the first time the user opens it we bump the range to "last7days"
  // — but only if they haven't already picked something themselves.
  const [dateRangeUserChanged, setDateRangeUserChanged] = useState(false);
  const [itemsTabAutoSet, setItemsTabAutoSet] = useState(false);
  const isMobile = useMobile();
  const { toast } = useToast();

  const handleDateRangeChange = (newRange: DateRange, start?: Date, end?: Date) => {
    queryClient.invalidateQueries();

    setDateRange(newRange);
    setCustomStartDate(start);
    setCustomEndDate(end);
    setDateRangeUserChanged(true);

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
      case "items":
        return (
          <ItemsPerformance
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
      />

      {/* No top navigation - using only bottom navigation */}

      <main className="flex-1 w-full overflow-y-auto px-4 py-4 space-y-6">
        <div className="w-full max-w-7xl mx-auto">
          {renderTabContent()}
        </div>
      </main>

      <BottomNavigation 
        activeTab={activeTab} 
        onTabChange={(tab) => {
          if (
            tab === "items"
            && !itemsTabAutoSet
            && !dateRangeUserChanged
            && dateRange === "today"
          ) {
            setItemsTabAutoSet(true);
            handleDateRangeChange("last7days");
            // handleDateRangeChange flips dateRangeUserChanged true, so
            // reset it back to false afterwards — this auto-bump should
            // not count as the user picking a range.
            setDateRangeUserChanged(false);
          }
          setActiveTab(tab);
        }} 
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