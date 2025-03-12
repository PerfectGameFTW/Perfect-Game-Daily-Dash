"use client"

import { useMemo } from "react"
import { TrendingUp } from "lucide-react"
import { 
  Bar, 
  BarChart, 
  CartesianGrid, 
  XAxis,
  ResponsiveContainer,
  YAxis,
  Tooltip
} from "recharts"
import { useQuery } from "@tanstack/react-query"
import { fetchHourlyRevenue } from "@/lib/squareApi"
import { DateRange, HourlyRevenue } from "@shared/schema"
import { formatCurrency } from "@/lib/dateUtils"
import { Skeleton } from "@/components/ui/skeleton"

// This is a simplified version that doesn't depend on shadcn components
// to ensure better compatibility

interface HourlyRevenueBarChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

// Custom tooltip component for the chart
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-card border border-border p-2 rounded-md shadow-md text-sm">
        <p className="font-medium">{label}</p>
        <p className="text-primary">
          {formatCurrency(payload[0].value)}
        </p>
      </div>
    );
  }
  return null;
};

export default function HourlyRevenueBarChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: HourlyRevenueBarChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/hourly-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyRevenue(dateRange, customStartDate, customEndDate),
  });
  
  // Format data for chart
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    console.log('Hourly Revenue Data received:', data);
    
    return data.map(item => {
      const amount = typeof item.amount === 'string' ? parseFloat(item.amount) : (item.amount || 0);
      return {
        hour: item.hour,
        amount: amount
      };
    });
  }, [data]);
  
  // Find the peak hour for all sales
  const peakHour = useMemo(() => {
    if (!data || data.length === 0) return null;
    return data.reduce((max, item) => (item.amount > max.amount ? item : max), data[0]);
  }, [data]);

  console.log('Chart data prepared:', chartData);

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
      <div className="relative h-52 w-full bg-card rounded-lg flex items-center justify-center">
        <p className="text-muted-foreground text-sm">No data available</p>
      </div>
    );
  }

  return (
    <div className="relative h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 20 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.2} />
          <XAxis
            dataKey="hour"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            // Only show every 3rd hour label to prevent overcrowding
            tickFormatter={(value, index) => index % 3 === 0 ? value.replace(/\s[AP]M$/, '') : ''}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `$${value}`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Bar
            dataKey="amount"
            fill="hsl(var(--primary))"
            radius={[4, 4, 0, 0]}
            name="Sales"
          />
        </BarChart>
      </ResponsiveContainer>
      
      {/* Peak hour information */}
      {peakHour && peakHour.amount > 0 && (
        <div className="absolute bottom-0 left-0 text-xs text-muted-foreground flex items-center gap-1 pb-2">
          <TrendingUp className="h-3 w-3 text-primary" />
          <span>Peak: {peakHour.hour} ({formatCurrency(peakHour.amount)})</span>
        </div>
      )}
    </div>
  );
}