import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { fetchHourlyRevenue } from "@/lib/squareApi";
import { DateRange, HourlyRevenue } from "@shared/schema";
import { formatCurrency } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock, TrendingUp } from "lucide-react";
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip,
  ResponsiveContainer,
  LabelList
} from 'recharts';

interface HourlyRevenueChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

// Format data for Recharts
const formatDataForChart = (data: HourlyRevenue[]) => {
  return data.map(item => ({
    name: item.hour,
    value: item.amount,
    formattedValue: formatCurrency(item.amount)
  }));
};

export default function HourlyRevenueChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: HourlyRevenueChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/hourly-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyRevenue(dateRange, customStartDate, customEndDate),
  });
  
  const [chartData, setChartData] = useState<Array<{name: string; value: number; formattedValue: string}>>([]);
  
  // Find the peak hour
  const peakHour = data && data.length > 0 
    ? data.reduce((max, item) => (item.amount > max.amount ? item : max), data[0])
    : null;

  useEffect(() => {
    if (data && data.length > 0) {
      setChartData(formatDataForChart(data));
    }
  }, [data]);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background/90 p-3 rounded-md shadow-md border border-border">
          <p className="text-sm font-medium">{payload[0].payload.name}</p>
          <p className="text-primary font-bold">
            {formatCurrency(payload[0].payload.value)}
          </p>
        </div>
      );
    }
    return null;
  };

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
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={chartData}
                margin={{ top: 10, right: 10, left: 0, bottom: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.1} />
                <XAxis 
                  dataKey="name" 
                  tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)', strokeWidth: 1 }}
                />
                <YAxis 
                  tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)', strokeWidth: 1 }}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--primary-foreground)', opacity: 0.1 }} />
                <Bar 
                  dataKey="value" 
                  fill="var(--primary)" 
                  radius={[4, 4, 0, 0]}
                  maxBarSize={50}
                  animationDuration={1500}
                >
                  <LabelList 
                    dataKey="formattedValue" 
                    position="top" 
                    style={{ 
                      fontSize: '10px',
                      fill: 'var(--muted-foreground)',
                      fontWeight: 500
                    }}
                    formatter={(value: string) => value !== '$0.00' ? value : ''}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
