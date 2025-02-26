import { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { fetchHourlyRevenue } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import Chart from "chart.js/auto";
import { Clock } from "lucide-react";

interface HourlyRevenueChartProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function HourlyRevenueChart({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: HourlyRevenueChartProps) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['/api/hourly-revenue', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchHourlyRevenue(dateRange, customStartDate, customEndDate),
  });

  // Find the peak hour
  const peakHour = data && data.length > 0 
    ? data.reduce((max, item) => (item.amount > max.amount ? item : max), data[0])
    : null;

  useEffect(() => {
    // Cleanup previous chart
    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    if (!chartRef.current || isLoading || !data) return;

    // Create new chart
    const ctx = chartRef.current.getContext('2d');
    if (!ctx) return;

    const primaryColor = '#375de7'; // Main blue color
    const accentColor = 'rgba(55, 93, 231, 0.1)'; // Lighter blue for background

    chartInstance.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.map(item => item.hour),
        datasets: [{
          label: 'Revenue',
          data: data.map(item => item.amount),
          borderColor: primaryColor,
          backgroundColor: accentColor,
          borderWidth: 3,
          tension: 0.4,
          fill: true,
          pointBackgroundColor: primaryColor,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(17, 24, 39, 0.9)',
            titleColor: '#fff',
            bodyColor: '#fff',
            padding: 12,
            boxPadding: 8,
            cornerRadius: 6,
            displayColors: false,
            callbacks: {
              label: function(context) {
                return formatCurrency(context.parsed.y);
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: {
              color: 'rgba(255, 255, 255, 0.1)'
              // Remove borderDash property as it's not supported
            },
            ticks: {
              color: 'rgba(255, 255, 255, 0.7)',
              padding: 10,
              callback: function(value) {
                return formatCurrency(value as number);
              }
            }
          },
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              display: false
            },
            ticks: {
              color: 'rgba(255, 255, 255, 0.7)',
              padding: 10
            }
          }
        },
        elements: {
          line: {
            tension: 0.4
          }
        },
        interaction: {
          mode: 'index',
          intersect: false
        },
        animation: {
          duration: 1000
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
    <Card className="overflow-hidden dashboard-card transition-all duration-200 border border-border/40 bg-card/50 backdrop-blur-sm">
      <CardHeader className="px-6 py-5 flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-xl font-semibold flex items-center space-x-2">
            <Clock size={20} className="mr-2 text-primary" />
            <span>Hourly Revenue</span>
          </CardTitle>
          {peakHour && !isLoading && (
            <CardDescription>
              Peak hour: {peakHour.hour} ({formatCurrency(peakHour.amount)})
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
            <canvas ref={chartRef}></canvas>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
