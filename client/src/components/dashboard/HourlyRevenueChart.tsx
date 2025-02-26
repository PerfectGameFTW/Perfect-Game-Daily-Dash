"use client"

import * as React from "react"
import { 
  Bar, 
  BarChart, 
  CartesianGrid, 
  XAxis,
  YAxis,
  ResponsiveContainer,
  Legend 
} from "recharts"
import { Clock, TrendingUp } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { fetchHourlyRevenue } from "@/lib/squareApi"
import { DateRange, HourlyRevenue } from "@shared/schema"
import { formatCurrency } from "@/lib/dateUtils"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

// Format data for Recharts using the enhanced API response
const formatDataForChart = (data: any[]) => {
  return data.map(item => {
    return {
      hour: item.hour,
      sales: item.regularSales || 0,
      giftCards: item.giftCardSales || 0,
      formattedSales: formatCurrency(item.regularSales || 0),
      formattedGiftCards: formatCurrency(item.giftCardSales || 0),
      date: item.hour // For tooltip
    };
  });
};

// Chart configuration - blue for sales, red for gift cards
const chartConfig = {
  hours: {
    label: "Hour",
  },
  sales: {
    label: "Regular Sales",
    color: "hsl(var(--chart-1))", // Blue
  },
  giftCards: {
    label: "Gift Card Sales",
    color: "hsl(var(--chart-2))", // Red
  },
} satisfies ChartConfig;

export default function HourlyRevenueChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: HourlyRevenueChartProps) {
  const [activeChart, setActiveChart] = React.useState<"combined" | "sales" | "giftCards">("combined");
  
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
    <Card className="overflow-hidden dashboard-card transition-all duration-200 border border-border/40 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 py-5 flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-xl font-semibold flex items-center">
            <Clock size={20} className="mr-2 text-primary" />
            <span>Hourly Revenue</span>
          </CardTitle>
          {peakHour && !isLoading && (
            <CardDescription className="flex items-center">
              <TrendingUp size={16} className="mr-1 text-green-500" />
              <span>Peak: {peakHour.hour} ({formatCurrency(peakHour.amount)})</span>
            </CardDescription>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        {isLoading ? (
          <div className="h-72 flex items-center justify-center">
            <Skeleton className="h-4/5 w-full" />
          </div>
        ) : (
          <div className="h-72">
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
                  <CartesianGrid vertical={false} opacity={0.1} />
                  <XAxis
                    dataKey="hour"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    fontSize={12}
                  />
                  <YAxis 
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `$${value}`}
                    fontSize={12}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        className="w-[150px]"
                        labelFormatter={(value) => {
                          return `${value}`;
                        }}
                      />
                    }
                  />
                  <Bar 
                    dataKey="sales" 
                    stackId="a"
                    name="Regular Sales"
                    fill="var(--color-sales)" 
                    radius={[4, 4, 0, 0]}
                    maxBarSize={40}
                  />
                  <Bar 
                    dataKey="giftCards" 
                    stackId="a"
                    name="Gift Card Sales"
                    fill="var(--color-giftCards)" 
                    radius={[4, 4, 0, 0]}
                    maxBarSize={40}
                  />
                  <Legend />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
