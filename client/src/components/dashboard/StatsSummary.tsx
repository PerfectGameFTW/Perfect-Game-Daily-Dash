import { useQuery } from "@tanstack/react-query";
import { fetchDailySummary } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatPercentage, isPositiveChange } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import SimpleHourlyChart from "./SimpleHourlyChart";
import { 
  ChevronUp, 
  ChevronDown 
} from "lucide-react";

interface StatsSummaryProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function StatsSummary({ dateRange, customStartDate, customEndDate }: StatsSummaryProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/summary', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDailySummary(dateRange, customStartDate, customEndDate),
  });

  if (isLoading) {
    return (
      <div className="mt-6">
        <Skeleton className="h-6 w-32 mb-3" />
        <Skeleton className="h-10 w-48 mb-1" />
        <Skeleton className="h-56 w-full mb-6" />
      </div>
    );
  }

  return (
    <div className="mt-4">
      {/* Main Sales Section */}
      <div className="mb-2">
        <h2 className="text-sm font-medium text-zinc-400">Gross sales</h2>
        <div className="flex items-center">
          <p className="text-xl font-bold text-white">{formatCurrency(data?.totalRevenue || 0)}</p>
          <div 
            className={`ml-2 px-2 py-1 rounded text-xs font-semibold flex items-center ${
              isPositiveChange(data?.revenueChange || 0)
                ? "bg-green-900/30 text-green-400"
                : "bg-red-900/30 text-red-400"
            }`}
          >
            {isPositiveChange(data?.revenueChange || 0) ? (
              <ChevronUp className="mr-0.5 h-3 w-3" />
            ) : (
              <ChevronDown className="mr-0.5 h-3 w-3" />
            )}
            {formatPercentage(Math.abs(data?.revenueChange || 0))}
          </div>
        </div>
      </div>
      
      {/* Hourly Revenue Chart */}
      <SimpleHourlyChart 
        dateRange={dateRange}
        customStartDate={customStartDate}
        customEndDate={customEndDate}
      />

      {/* Metrics Section */}
      <div className="mb-3 flex justify-between items-center">
        <h2 className="text-xl font-bold text-white">Metrics</h2>
        <div className="bg-zinc-800 px-3 py-1 rounded-full text-sm text-zinc-300">
          vs. Prior {dateRange === 'today' ? 'Day' : 'Period'}
        </div>
      </div>

      {/* Metric Items */}
      <div className="space-y-5">
        {/* Net Sales Item */}
        <div className="flex justify-between py-3 border-b border-zinc-800">
          <span className="text-white">Net sales</span>
          <div className="flex items-center">
            <span className="text-white mr-3">{formatCurrency(data?.totalRevenue || 0)}</span>
            <div 
              className={`px-2 py-1 rounded text-xs font-semibold flex items-center ${
                isPositiveChange(data?.revenueChange || 0)
                  ? "bg-green-900/30 text-green-400"
                  : "bg-red-900/30 text-red-400"
              }`}
            >
              {isPositiveChange(data?.revenueChange || 0) ? (
                <ChevronUp className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              )}
              {formatPercentage(Math.abs(data?.revenueChange || 0))}
            </div>
          </div>
        </div>

        {/* Gross Sales Item */}
        <div className="flex justify-between py-3 border-b border-zinc-800">
          <span className="text-white">Gross sales</span>
          <div className="flex items-center">
            <span className="text-white mr-3">{formatCurrency(data?.totalRevenue || 0)}</span>
            <div 
              className={`px-2 py-1 rounded text-xs font-semibold flex items-center ${
                isPositiveChange(data?.revenueChange || 0)
                  ? "bg-green-900/30 text-green-400"
                  : "bg-red-900/30 text-red-400"
              }`}
            >
              {isPositiveChange(data?.revenueChange || 0) ? (
                <ChevronUp className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              )}
              {formatPercentage(Math.abs(data?.revenueChange || 0))}
            </div>
          </div>
        </div>

        {/* Transactions Item */}
        <div className="flex justify-between py-3 border-b border-zinc-800">
          <span className="text-white">Transactions</span>
          <div className="flex items-center">
            <span className="text-white mr-3">{data?.totalOrders || 0}</span>
            <div 
              className={`px-2 py-1 rounded text-xs font-semibold flex items-center ${
                isPositiveChange(data?.ordersChange || 0)
                  ? "bg-green-900/30 text-green-400"
                  : "bg-red-900/30 text-red-400"
              }`}
            >
              {isPositiveChange(data?.ordersChange || 0) ? (
                <ChevronUp className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              )}
              {formatPercentage(Math.abs(data?.ordersChange || 0))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
