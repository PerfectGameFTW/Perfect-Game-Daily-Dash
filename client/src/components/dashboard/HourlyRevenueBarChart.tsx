"use client"

import { useMemo, useEffect } from "react"
import { TrendingUp } from "lucide-react"
import { 
  Bar, 
  BarChart, 
  CartesianGrid, 
  XAxis,
  ResponsiveContainer,
  YAxis
} from "recharts"
import { useQuery } from "@tanstack/react-query"
import { fetchHourlyRevenue } from "@/lib/squareApi"
import { DateRange, HourlyRevenue } from "@shared/schema"
import { formatCurrency } from "@/lib/dateUtils"
import { Skeleton } from "@/components/ui/skeleton"

import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"

interface HourlyRevenueBarChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

// Format data for Recharts using the hourly revenue data
const formatDataForChart = (data: HourlyRevenue[]) => {
  // Log data to inspect
  console.log('Hourly Revenue Data from API:', data);
  
  return data.map(item => {
    // For a real stacked chart, we would have multiple values here
    // Since we only have one value (total revenue), we'll use that for the primary series
    // Make sure we handle different data types correctly
    const amount = typeof item.amount === 'string' ? parseFloat(item.amount) : (item.amount || 0);
    
    return {
      hour: item.hour,
      sales: amount,
      formattedAmount: formatCurrency(amount),
    };
  });
};

// Chart configuration with colors
const chartConfig = {
  sales: {
    label: "Sales",
    color: "hsl(var(--primary))",
  }
} satisfies ChartConfig;

export default function HourlyRevenueBarChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: HourlyRevenueBarChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/hourly-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyRevenue(dateRange, customStartDate, customEndDate),
  });
  
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return formatDataForChart(data);
  }, [data]);
  
  // Find the peak hour for all sales
  const peakHour = useMemo(() => {
    if (!data || data.length === 0) return null;
    return data.reduce((max, item) => (item.amount > max.amount ? item : max), data[0]);
  }, [data]);

  // Calculate total
  const totalRevenue = useMemo(() => {
    if (!data || data.length === 0) return 0;
    return data.reduce((sum, item) => sum + (item.amount || 0), 0);
  }, [data]);

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
        <p className="text-muted-foreground text-sm">No data available</p>
      </div>
    );
  }

  // Get subset of data to display - we could filter to only show hours with activity
  // But we'll show all hours for consistency
  const displayData = chartData;

  // Set a CSS variable for the bar color to ensure it's available
  // We'll use the primary color as fallback
  useEffect(() => {
    document.documentElement.style.setProperty('--color-sales', 'hsl(var(--primary))');
  }, []);

  return (
    <div className="relative h-[320px] w-full">
      <ChartContainer config={chartConfig} className="h-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={displayData}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" opacity={0.2} />
            <XAxis
              dataKey="hour"
              tickLine={false}
              tickMargin={10}
              axisLine={false}
              // Only show every 3rd hour label to prevent overcrowding
              tickFormatter={(value, index) => index % 3 === 0 ? value.replace(/\s[AP]M$/, '') : ''}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `$${value}`}
            />
            <ChartTooltip content={<ChartTooltipContent hideLabel />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar
              dataKey="sales"
              fill="hsl(var(--primary))" // Use direct HSL value instead of var reference
              radius={[4, 4, 0, 0]}
              name="Sales"
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartContainer>
      
      {/* Optional additional information */}
      {peakHour && peakHour.amount > 0 && (
        <div className="absolute bottom-0 left-0 text-xs text-muted-foreground flex items-center gap-1 pb-2">
          <TrendingUp className="h-3 w-3 text-primary" />
          <span>Peak: {peakHour.hour} ({formatCurrency(peakHour.amount)})</span>
        </div>
      )}
    </div>
  );
}