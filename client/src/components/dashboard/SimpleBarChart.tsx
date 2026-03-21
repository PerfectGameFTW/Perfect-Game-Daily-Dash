"use client"

import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DateRange } from "@shared/schema";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/dateUtils";

interface SimpleBarChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

// Direct fetch from API to avoid any potential issues with the query client
const fetchHourlyData = async (dateRange: DateRange, startDate?: Date, endDate?: Date) => {
  let url = `/api/hourly-revenue?dateRange=${dateRange}`;
  
  if (startDate) {
    url += `&startDate=${startDate.toISOString()}`;
  }
  
  if (endDate) {
    url += `&endDate=${endDate.toISOString()}`;
  }
  
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`API request failed with status ${response.status}`);
  }
  
  return response.json();
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 p-2 rounded shadow-md">
        <p className="font-medium">{label}</p>
        <p className="text-primary">{formatCurrency(payload[0].value)}</p>
      </div>
    );
  }
  return null;
};

export default function SimpleBarChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: SimpleBarChartProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['hourly-revenue-simple', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyData(dateRange, customStartDate, customEndDate),
  });
  
  if (isLoading) {
    return (
      <div className="relative h-52 w-full">
        <Skeleton className="h-full w-full rounded-lg" />
      </div>
    );
  }
  
  if (error || !data) {
    return (
      <div className="relative h-52 w-full bg-gray-50 rounded-lg flex items-center justify-center">
        <p className="text-gray-500 text-sm">Error loading chart data</p>
      </div>
    );
  }

  // In case there's no data
  if (data.length === 0) {
    return (
      <div className="relative h-52 w-full bg-gray-50 rounded-lg flex items-center justify-center">
        <p className="text-gray-500 text-sm">No data available</p>
      </div>
    );
  }

  return (
    <div className="relative h-[320px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
          <XAxis 
            dataKey="hour" 
            tickFormatter={(value, index) => index % 3 === 0 ? value.replace(/\s[AP]M$/, '') : ''}
          />
          <YAxis tickFormatter={(value) => `$${value}`} />
          <Tooltip content={<CustomTooltip />} />
          <Bar 
            dataKey="amount" 
            fill="hsl(var(--primary))" 
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}