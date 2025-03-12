import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchGiftCardSummary } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import { CreditCard, DollarSign, RefreshCcw, TrendingUp } from "lucide-react";
import Chart from "chart.js/auto";

interface GiftCardActivityProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function GiftCardActivity({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: GiftCardActivityProps) {
  const chartRef = useRef<HTMLCanvasElement>(null);
  const chartInstance = useRef<Chart | null>(null);

  // API data fetching
  const { data, isLoading } = useQuery({
    queryKey: ['/api/gift-card-summary', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchGiftCardSummary(dateRange, customStartDate, customEndDate),
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
        labels: ['Gift Card Sales', 'Gift Card Redemptions'],
        datasets: [{
          data: [data.soldAmount, data.redeemedAmount],
          backgroundColor: [
            'hsl(var(--primary) / 0.9)',  // Primary color with alpha
            'hsl(var(--accent) / 0.7)'    // Accent color with alpha
          ],
          borderColor: [
            'hsl(var(--primary))',        // Primary color
            'hsl(var(--accent) / 0.8)'    // Accent color with alpha
          ],
          borderWidth: 2,
          hoverOffset: 6,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '75%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: 'hsl(var(--muted-foreground))',
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
                      strokeStyle: 'hsl(var(--border) / 0.5)',
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
            backgroundColor: 'hsl(var(--card) / 0.8)',
            borderColor: 'hsl(var(--border))',
            borderWidth: 1,
            padding: 10,
            titleColor: 'hsl(var(--card-foreground))',
            bodyColor: 'hsl(var(--muted-foreground))',
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

  return (
    <div className="bg-card backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl overflow-hidden">
      <div className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold flex items-center text-card-foreground">
            <CreditCard size={20} className="mr-2 text-primary" />
            <span>Gift Card Activity</span>
          </h2>
          {data && !isLoading && (
            <div className="flex items-center text-muted-foreground text-sm">
              <TrendingUp size={16} className="mr-1 text-primary" />
              <span>Total sales: {formatCurrency(data?.soldAmount || 0)}</span>
            </div>
          )}
        </div>
      </div>
      
      {isLoading ? (
        <>
          <div className="mt-6 h-64 flex items-center justify-center">
            <Skeleton className="h-4/5 w-4/5 rounded-full" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4">
            {Array(4).fill(0).map((_, index) => (
              <div key={index} className="bg-accent/20 rounded-lg p-4">
                <Skeleton className="h-5 w-24 mb-2" />
                <Skeleton className="h-7 w-16" />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between mb-4">
            <h4 className="text-base font-medium text-card-foreground">
              {dateRange === 'yesterday' ? 'Gift Card Sales Yesterday' : 'Gift Card Sales Today'}
            </h4>
            <span className="text-2xl font-bold text-primary">{formatCurrency(data?.soldAmount || 0)}</span>
          </div>
          
          {/* Donut Chart for Gift Card Sales vs Redemptions */}
          <div className="mt-2 h-64">
            <canvas ref={chartRef}></canvas>
            
            {/* Horizontal bars showing percentages */}
            <div className="mt-4 space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Gift Card Sales</span>
                  <span className="font-semibold text-card-foreground">{formatCurrency(data?.soldAmount || 0)}</span>
                </div>
                <div className="h-2 bg-accent/20 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-primary rounded-full" 
                    style={{ 
                      width: `${data?.soldAmount ? Math.min(100, (data.soldAmount / (data.soldAmount + data.redeemedAmount + 0.01)) * 100) : 0}%` 
                    }} 
                  />
                </div>
              </div>
              
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-muted-foreground">Gift Card Redemptions</span>
                  <span className="font-semibold text-card-foreground">{formatCurrency(data?.redeemedAmount || 0)}</span>
                </div>
                <div className="h-2 bg-accent/20 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-accent rounded-full" 
                    style={{ 
                      width: `${data?.redeemedAmount ? Math.min(100, (data.redeemedAmount / (data.soldAmount + data.redeemedAmount + 0.01)) * 100) : 0}%` 
                    }} 
                  />
                </div>
              </div>
            </div>
          </div>
          
          {/* Gift Card Metrics */}
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center mr-3">
                  <CreditCard className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Cards Sold</div>
                  <div className="mt-1 text-xl font-bold text-card-foreground">{data?.soldCount || 0}</div>
                </div>
              </div>
            </div>
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center mr-3">
                  <RefreshCcw className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Cards Redeemed</div>
                  <div className="mt-1 text-xl font-bold text-card-foreground">{data?.redeemedCount || 0}</div>
                </div>
              </div>
            </div>
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center mr-3">
                  <DollarSign className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Avg. Card Value</div>
                  <div className="mt-1 text-xl font-bold text-card-foreground">{formatCurrency(data?.averageValue || 0)}</div>
                </div>
              </div>
            </div>
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center mr-3">
                  <TrendingUp className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-sm font-medium text-muted-foreground">Redemption Value</div>
                  <div className="mt-1 text-xl font-bold text-card-foreground">{formatCurrency(data?.redeemedAmount || 0)}</div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
