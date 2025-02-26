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
  
  // Filter out hours with no activity for a cleaner display
  const hoursWithActivity = data.filter(hour => hour.amount > 0);
  
  // If no hours have activity, show the no data message
  if (hoursWithActivity.length === 0) {
    return (
      <div className="relative h-36 w-full mb-8 bg-black border-t border-b border-zinc-800 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">No sales activity in this period</p>
      </div>
    );
  }
  
  // Find the earliest and latest hours with activity
  const hourIndices = hoursWithActivity.map(hour => {
    const hourMatch = hour.hour.match(/(\d+)(?:\s)([AP]M)/);
    if (!hourMatch) return 0;
    
    const hourNum = parseInt(hourMatch[1], 10);
    const ampm = hourMatch[2];
    
    // Convert to 24-hour format for sorting
    if (ampm === 'AM') {
      return hourNum === 12 ? 0 : hourNum;
    } else {
      return hourNum === 12 ? 12 : hourNum + 12;
    }
  });
  
  // Get subset of data to display - show all hours with activity
  // If there's too much data, focus on hours with activity
  const displayData = hoursWithActivity.length <= 12 ? data : hoursWithActivity;

  return (
    <div className="relative h-36 w-full mb-8 bg-black border-t border-b border-zinc-800">
      <div className="absolute left-0 text-xs text-zinc-500">${roundedMax}</div>
      <div className="absolute left-0 top-1/2 text-xs text-zinc-500">${halfValue}</div>
      <div className="absolute left-0 bottom-0 text-xs text-zinc-500">$0</div>
      
      <div className="flex justify-between items-end h-full px-5 pt-6 pb-2">
        {displayData.map((hour, index) => {
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
        {displayData.map((hour, index) => {
          // Only show every other label if we have many hours, to prevent overlap
          if (displayData.length > 8 && index % 2 !== 0 && index !== 0 && index !== displayData.length - 1) {
            return <span key={index} className="opacity-0">{hour.hour.replace(/\s[AP]M$/, '')}</span>;
          }
          return (
            <span key={index}>
              {hour.hour.replace(/\s[AP]M$/, '')}
            </span>
          );
        })}
      </div>
    </div>
  );
}