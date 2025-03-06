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
      <div className="relative h-52 w-full">
        <Skeleton className="h-full w-full rounded-lg" />
      </div>
    );
  }

  // In case there's no data
  if (!data || data.length === 0) {
    return (
      <div className="relative h-52 w-full bg-white/5 rounded-lg flex items-center justify-center">
        <p className="text-white/50 text-sm">No data available</p>
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
      <div className="relative h-52 w-full bg-white/5 rounded-lg flex items-center justify-center">
        <p className="text-white/50 text-sm">No sales activity in this period</p>
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
    <div className="relative h-52 w-full pb-8">
      {/* Y-axis labels with prettier formatting */}
      <div className="absolute -left-1 top-0 text-xs text-white/40 font-medium">${roundedMax}</div>
      <div className="absolute -left-1 top-1/2 text-xs text-white/40 font-medium">${halfValue}</div>
      <div className="absolute -left-1 bottom-8 text-xs text-white/40 font-medium">$0</div>
      
      {/* Grid lines for better readability */}
      <div className="absolute left-0 right-0 top-0 border-t border-dashed border-white/10 h-[1px]" />
      <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-white/10 h-[1px]" />
      <div className="absolute left-0 right-0 bottom-8 border-t border-dashed border-white/10 h-[1px]" />
      
      {/* Bars container */}
      <div className="flex justify-between items-end h-full px-5 pt-6 pb-10">
        {displayData.map((hour, index) => {
          // Calculate height as percentage of max value (with a minimum of 5% for visibility)
          const heightPercent = hour.amount > 0 
            ? 5 + ((hour.amount / roundedMax) * 95) 
            : 0;
          
          return (
            <div 
              key={index} 
              className="group relative"
            >
              {/* Bar itself with gradient */}
              <div
                className="relative w-5 rounded-t-md bg-gradient-to-t from-primary/70 to-primary cursor-pointer transition-all hover:from-primary/90 hover:to-primary hover:w-6"
                style={{ height: `${heightPercent}%` }}
              />
              
              {/* Tooltip on hover */}
              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 -translate-y-2 opacity-0 group-hover:opacity-100 bg-black/80 backdrop-blur-sm text-white p-2 rounded text-xs whitespace-nowrap transition-all z-10">
                {hour.hour}: {formatCurrency(hour.amount)}
              </div>
              
              {/* Help with spacing for the x-axis labels */}
              <div className="absolute bottom-0 left-0 w-full h-8"></div>
            </div>
          );
        })}
      </div>
      
      {/* X-axis labels */}
      <div className="flex justify-between px-3 text-xs text-white/40 mt-2 absolute bottom-0 left-0 right-0">
        {displayData.map((hour, index) => {
          // Only show every other label if we have many hours, to prevent overlap
          if (displayData.length > 8 && index % 2 !== 0 && index !== 0 && index !== displayData.length - 1) {
            return <span key={index} className="opacity-0">{hour.hour.replace(/\s[AP]M$/, '')}</span>;
          }
          return (
            <span key={index} className="font-medium">
              {hour.hour.replace(/\s[AP]M$/, '')}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Helper function for formatting currency in tooltips
function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}