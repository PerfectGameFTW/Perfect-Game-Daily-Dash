"use client"

import * as React from "react"
import { 
  Bar, 
  BarChart, 
  CartesianGrid, 
  XAxis,
  YAxis,
  ResponsiveContainer
} from "recharts"
import { Clock, TrendingUp } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { fetchHourlyRevenue } from "@/lib/squareApi"
import { DateRange, HourlyRevenue } from "@shared/schema"
import { formatCurrency } from "@/lib/dateUtils"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"

interface HourlyRevenueChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

// Format data for Recharts using the hourly revenue data
const formatDataForChart = (data: HourlyRevenue[]) => {
  return data.map(item => {
    return {
      hour: item.hour,
      amount: item.amount || 0,
      formattedAmount: formatCurrency(item.amount || 0),
      date: item.hour // For tooltip
    };
  });
};

// Chart configuration - slate for sales
const chartConfig = {
  hours: {
    label: "Hour",
  },
  amount: {
    label: "Revenue",
    color: "#64748b", // slate-500
  },
} satisfies ChartConfig;

export default function HourlyRevenueChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: HourlyRevenueChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/hourly-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyRevenue(dateRange, customStartDate, customEndDate),
  });
  
  const chartData = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    return formatDataForChart(data);
  }, [data]);
  
  // Find the peak hour for all sales
  const peakHour = React.useMemo(() => {
    if (!data || data.length === 0) return null;
    return data.reduce((max, item) => (item.amount > max.amount ? item : max), data[0]);
  }, [data]);

  return (
    <div className="bg-slate-800/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl overflow-hidden">
      <div className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold flex items-center text-white">
            <Clock size={20} className="mr-2 text-slate-400" />
            <span>Hourly Revenue</span>
          </h2>
          {peakHour && !isLoading && (
            <div className="flex items-center text-white/70 text-sm">
              <TrendingUp size={16} className="mr-1 text-white" />
              <span>Peak: {peakHour.hour} ({formatCurrency(peakHour.amount)})</span>
            </div>
          )}
        </div>
        <div className="flex items-center px-3 py-1.5 bg-slate-400/10 text-slate-400 rounded-lg text-sm font-medium">
          <TrendingUp size={14} className="mr-1.5" />
          <span>Hourly Pattern</span>
        </div>
      </div>
      <div className="mt-4">
        {isLoading ? (
          <div className="h-80 flex items-center justify-center">
            <Skeleton className="h-4/5 w-full rounded-lg" />
          </div>
        ) : (
          <div className="h-80">
            <ChartContainer
              config={chartConfig}
              className="aspect-auto h-full w-full"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{
                    top: 20,
                    right: 10,
                    left: 10,
                    bottom: 20,
                  }}
                  barGap={0}
                  barCategoryGap={8}
                >
                  <CartesianGrid vertical={false} horizontal={true} opacity={0.1} />
                  <XAxis
                    dataKey="hour"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    fontSize={12}
                    stroke="#ffffff50"
                  />
                  <YAxis 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `$${value}`}
                    fontSize={12}
                    stroke="#ffffff50"
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        className="w-[150px] bg-slate-800/80 border border-white/10 shadow-lg backdrop-blur-sm"
                        labelFormatter={(value) => {
                          return `${value}`;
                        }}
                      />
                    }
                  />
                  <Bar 
                    dataKey="amount" 
                    name="Revenue"
                    fill="var(--color-amount)" 
                    radius={[4, 4, 0, 0]}
                    maxBarSize={40}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        )}
      </div>
    </div>
  );
}
