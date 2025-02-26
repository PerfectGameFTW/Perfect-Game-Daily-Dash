import { useState } from "react";
import Header from "@/components/dashboard/Header";
import StatsSummary from "@/components/dashboard/StatsSummary";
import BottomNavigation from "@/components/dashboard/BottomNavigation";
import TimeframeModal from "@/components/dashboard/TimeframeModal";
import { DateRange } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";

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
      <main className="flex-1 overflow-y-auto px-4">
        {/* Stats Overview */}
        <StatsSummary 
          dateRange={dateRange} 
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
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
