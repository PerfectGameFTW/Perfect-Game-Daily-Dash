import { useState } from "react";
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

export default function Dashboard() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [timeframeModalOpen, setTimeframeModalOpen] = useState(false);
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

  return (
    <div className="flex flex-col min-h-screen bg-black text-white pb-16">
      {/* Header */}
      <Header 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
        onDateRangeChange={handleDateRangeChange}
        onOpenTimeframeModal={() => setTimeframeModalOpen(true)}
      />

      {/* Dashboard Content */}
      <main className="flex-1 overflow-y-auto px-4 space-y-6">
        {/* Stats Overview */}
        <StatsSummary 
          dateRange={dateRange} 
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
        
        {/* Revenue Charts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <RevenueByCategoryChart 
            dateRange={dateRange}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
          <HourlyRevenueChart 
            dateRange={dateRange}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
        </div>
        
        {/* Tabbed Content for Transactions and Gift Cards */}
        <Tabs defaultValue="transactions" className="w-full">
          <TabsList className="bg-zinc-900 border border-zinc-800">
            <TabsTrigger value="transactions" className="data-[state=active]:bg-zinc-800">
              Recent Transactions
            </TabsTrigger>
            <TabsTrigger value="giftcards" className="data-[state=active]:bg-zinc-800">
              Gift Card Activity
            </TabsTrigger>
          </TabsList>
          <TabsContent value="transactions">
            <RecentTransactionsTable 
              dateRange={dateRange}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
            />
          </TabsContent>
          <TabsContent value="giftcards">
            <GiftCardActivity 
              dateRange={dateRange}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
            />
          </TabsContent>
        </Tabs>
      </main>
      
      {/* Bottom Navigation */}
      <BottomNavigation />
      
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
