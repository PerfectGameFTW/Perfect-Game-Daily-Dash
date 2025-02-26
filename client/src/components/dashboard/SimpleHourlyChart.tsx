import { useQuery } from "@tanstack/react-query";
import { fetchHourlyRevenue } from "@/lib/squareApi";
import { DateRange, HourlyRevenue } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";

interface SimpleHourlyChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function SimpleHourlyChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: SimpleHourlyChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/hourly-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyRevenue(dateRange, customStartDate, customEndDate),
  });
  
  if (isLoading) {
    return (
      <div className="relative h-36 w-full mb-8 bg-black border-t border-b border-zinc-800">
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  // In case there's no data
  if (!data || data.length === 0) {
    return (
      <div className="relative h-36 w-full mb-8 bg-black border-t border-b border-zinc-800 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">No data available</p>
      </div>
    );
  }

  // Find max value for scaling
  const maxValue = Math.max(...data.map(item => item.amount));
  const roundedMax = Math.ceil(maxValue / 100) * 100;
  const halfValue = Math.round(roundedMax / 2);

  return (
    <div className="relative h-36 w-full mb-8 bg-black border-t border-b border-zinc-800">
      <div className="absolute left-0 text-xs text-zinc-500">{roundedMax}</div>
      <div className="absolute left-0 top-1/2 text-xs text-zinc-500">{halfValue}</div>
      <div className="absolute left-0 bottom-0 text-xs text-zinc-500">0</div>
      
      <div className="flex justify-between items-end h-full px-5 pt-6 pb-2">
        {data.map((hour, index) => {
          // Calculate height as percentage of max value (with a minimum of 5% for visibility)
          const heightPercent = hour.amount > 0 
            ? 5 + ((hour.amount / roundedMax) * 95) 
            : 0;
          
          return (
            <div 
              key={index} 
              className="relative w-1 bg-blue-500"
              style={{ height: `${heightPercent}%` }}
              title={`${hour.hour}: $${hour.amount.toFixed(2)}`}
            />
          );
        })}
      </div>
      
      <div className="flex justify-between px-3 text-xs text-zinc-500 mt-1">
        {data.slice(0, 6).map((hour, index) => (
          <span key={index}>
            {hour.hour.replace(/\s[AP]M$/, '')}
          </span>
        ))}
      </div>
    </div>
  );
}