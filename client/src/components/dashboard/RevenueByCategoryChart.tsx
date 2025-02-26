import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { fetchCategoryRevenue } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import Chart from "chart.js/auto";

interface RevenueByCategoryChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function RevenueByCategoryChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: RevenueByCategoryChartProps) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['/api/revenue-by-category', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchCategoryRevenue(dateRange, customStartDate, customEndDate),
  });

  useEffect(() => {
    // Cleanup previous chart
    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    if (!chartRef.current || isLoading || !data) return;

    // Create new chart
    const ctx = chartRef.current.getContext('2d');
    if (!ctx) return;

    chartInstance.current = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: data.map(item => item.category),
        datasets: [{
          label: 'Revenue by Category',
          data: data.map(item => item.amount),
          backgroundColor: data.map(item => item.color),
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function(value) {
                return formatCurrency(value as number);
              }
            }
          }
        }
      }
    });

    // Cleanup on unmount
    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data, isLoading, dateRange]);

  return (
    <Card className="overflow-hidden shadow dashboard-card hover:shadow-lg transition-all duration-200 transform hover:-translate-y-1">
      <CardHeader className="px-4 py-5 sm:px-6">
        <CardTitle className="text-lg leading-6 font-medium text-gray-900">Revenue by Category</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-5 sm:px-6">
        {isLoading ? (
          <div className="mt-4 h-72 flex items-center justify-center">
            <Skeleton className="h-4/5 w-full" />
          </div>
        ) : (
          <div className="mt-4 h-72">
            <canvas ref={chartRef}></canvas>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
