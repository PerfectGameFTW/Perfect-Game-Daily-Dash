import { useState } from "react";
import Sidebar from "@/components/dashboard/Sidebar";
import Header from "@/components/dashboard/Header";
import StatsSummary from "@/components/dashboard/StatsSummary";
import RevenueByCategoryChart from "@/components/dashboard/RevenueByCategoryChart";
import HourlyRevenueChart from "@/components/dashboard/HourlyRevenueChart";
import RecentTransactionsTable from "@/components/dashboard/RecentTransactionsTable";
import GiftCardActivity from "@/components/dashboard/GiftCardActivity";
import { DateRange } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import useMobile from "@/hooks/use-mobile";

export default function Dashboard() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const { toast } = useToast();
  const isMobile = useMobile();

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
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <Sidebar open={sidebarOpen} setOpen={setSidebarOpen} />

      {/* Main Content */}
      <div className="flex flex-col w-0 flex-1 overflow-hidden">
        {/* Top Header */}
        <Header 
          openSidebar={() => setSidebarOpen(true)} 
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
          onDateRangeChange={handleDateRangeChange}
        />

        {/* Dashboard Content */}
        <main className="flex-1 relative overflow-y-auto focus:outline-none">
          <div className="py-6">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8">
              <h1 className="text-2xl font-semibold text-gray-900">Daily Sales Summary</h1>

              {/* Stats Overview */}
              <StatsSummary 
                dateRange={dateRange} 
                customStartDate={customStartDate}
                customEndDate={customEndDate}
              />

              {/* Charts Section */}
              <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-2">
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

              {/* Tables Section */}
              <div className="mt-8 grid grid-cols-1 gap-5 lg:grid-cols-2">
                <RecentTransactionsTable 
                  dateRange={dateRange}
                  customStartDate={customStartDate}
                  customEndDate={customEndDate}
                />
                <GiftCardActivity 
                  dateRange={dateRange}
                  customStartDate={customStartDate}
                  customEndDate={customEndDate}
                />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
