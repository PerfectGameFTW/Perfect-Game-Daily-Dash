import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCategoryRevenue } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import { ChartPie, PieChart } from "lucide-react";
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
    queryKey: ['/api/category-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
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
      type: 'doughnut',
      data: {
        labels: data.map(item => item.category),
        datasets: [{
          label: 'Revenue by Category',
          data: data.map(item => item.amount),
          backgroundColor: data.map(item => item.color),
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 2,
          hoverOffset: 6,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: 'rgba(255, 255, 255, 0.7)',
              padding: 15,
              font: {
                size: 12
              },
              generateLabels: (chart) => {
                const data = chart.data;
                if (data.labels?.length && data.datasets.length) {
                  return data.labels.map((label, i) => {
                    const value = data.datasets[0].data[i] as number;
                    const backgroundColor = Array.isArray(data.datasets[0].backgroundColor) 
                      ? data.datasets[0].backgroundColor[i] 
                      : undefined;
                    
                    return {
                      text: `${label}: ${formatCurrency(value)}`,
                      fillStyle: backgroundColor,
                      strokeStyle: '#ffffff20',
                      lineWidth: 1,
                      hidden: false,
                      index: i
                    };
                  });
                }
                return [];
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                const label = context.label || '';
                const value = context.raw as number;
                return `${label}: ${formatCurrency(value)}`;
              }
            },
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 10,
            bodyFont: {
              size: 12
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

  const totalRevenue = data ? data.reduce((sum, item) => sum + item.amount, 0) : 0;
  const topCategory = data ? 
    [...data].sort((a, b) => b.amount - a.amount)[0]?.category : 
    'No data';

  return (
    <div className="bg-slate-800/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl overflow-hidden">
      <div className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold flex items-center text-white">
            <ChartPie size={20} className="mr-2 text-slate-400" />
            <span>Revenue by Category</span>
          </h2>
          {data && !isLoading && (
            <div className="flex items-center text-white/70 text-sm">
              <PieChart size={16} className="mr-1 text-white" />
              <span>Top: {topCategory} ({formatCurrency(totalRevenue)})</span>
            </div>
          )}
        </div>
        <div className="flex items-center px-3 py-1.5 bg-slate-400/10 text-slate-400 rounded-lg text-sm font-medium">
          <PieChart size={14} className="mr-1.5" />
          <span>Category Split</span>
        </div>
      </div>
      <div className="mt-4">
        {isLoading ? (
          <div className="h-80 flex items-center justify-center">
            <Skeleton className="h-4/5 w-full rounded-lg" />
          </div>
        ) : (
          <div className="h-80">
            <canvas ref={chartRef}></canvas>
          </div>
        )}
      </div>
    </div>
  );
}
