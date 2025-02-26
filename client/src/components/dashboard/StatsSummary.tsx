import { useQuery } from "@tanstack/react-query";
import { fetchDailySummary } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatPercentage, isPositiveChange } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
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
    <div className="mt-4 w-full">
      {/* Main Sales Section */}
      <div className="mb-8">
        <h2 className="text-sm font-medium text-zinc-400">Gross sales</h2>
        <div className="flex items-center">
          <p className="text-3xl md:text-4xl font-bold text-white">{formatCurrency(data?.totalRevenue || 0)}</p>
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

      {/* Metrics Section */}
      <div className="mb-6 flex justify-between items-center">
        <h2 className="text-xl md:text-2xl font-bold text-white">Metrics</h2>
        <div className="bg-zinc-800 px-3 py-1 rounded-full text-sm md:text-base text-zinc-300">
          vs. Prior {dateRange === 'today' ? 'Day' : 'Period'}
        </div>
      </div>

      {/* Metric Items - Grid for desktop, stack for mobile */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-8">
        {/* Net Sales Item */}
        <div className="bg-zinc-900/50 rounded-xl p-4 md:p-6">
          <div className="text-zinc-500 text-sm md:text-base mb-2">Net sales</div>
          <div className="text-white text-xl md:text-2xl font-bold mb-2">{formatCurrency(data?.totalRevenue || 0)}</div>
          <div 
            className={`inline-flex px-2 py-1 rounded text-xs font-semibold items-center ${
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

        {/* Gross Sales Item */}
        <div className="bg-zinc-900/50 rounded-xl p-4 md:p-6">
          <div className="text-zinc-500 text-sm md:text-base mb-2">Gross sales</div>
          <div className="text-white text-xl md:text-2xl font-bold mb-2">{formatCurrency(data?.totalRevenue || 0)}</div>
          <div 
            className={`inline-flex px-2 py-1 rounded text-xs font-semibold items-center ${
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

        {/* Transactions Item */}
        <div className="bg-zinc-900/50 rounded-xl p-4 md:p-6">
          <div className="text-zinc-500 text-sm md:text-base mb-2">Transactions</div>
          <div className="text-white text-xl md:text-2xl font-bold mb-2">{data?.totalOrders || 0}</div>
          <div 
            className={`inline-flex px-2 py-1 rounded text-xs font-semibold items-center ${
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
  );
}
