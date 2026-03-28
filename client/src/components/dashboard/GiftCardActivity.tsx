import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchGiftCardSummary } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
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

  const { data, isLoading } = useQuery({
    queryKey: ['/api/gift-card-summary', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchGiftCardSummary(dateRange, customStartDate, customEndDate),
    refetchInterval: false,
  });

  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.destroy();
    }

    if (!chartRef.current || isLoading || !data) return;

    const ctx = chartRef.current.getContext('2d');
    if (!ctx) return;

    const primaryColor = '#0A3161';
    const secondaryColor = '#C4D600';
    
    chartInstance.current = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Total Gift Card Sales', 'Total Gift Card Redemptions'],
        datasets: [{
          data: [data.soldAmount, data.redeemedAmount],
          backgroundColor: [
            primaryColor + 'e6',
            secondaryColor + 'b3'
          ],
          borderColor: [
            primaryColor,
            secondaryColor + 'cc'
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

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
      }
    };
  }, [data, isLoading, dateRange]);

  return (
    <div className="bg-card backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl overflow-hidden">
      <div className="text-center">
        <h2 className="text-xl font-bold text-card-foreground">
          True Gift Card Activity
        </h2>
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
          <div className="mt-4 h-64">
            <canvas ref={chartRef}></canvas>
          </div>
          
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Total Outstanding Value</div>
                <div className="mt-1 text-xl font-bold text-card-foreground">{formatCurrency(data?.outstandingBalance || 0)}</div>
              </div>
            </div>
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Web Res Adv Deposits</div>
                <div className="mt-1 text-xl font-bold text-card-foreground">{formatCurrency(data?.webResAdvDeposits || 0)}</div>
              </div>
            </div>
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Cards Redeemed</div>
                <div className="mt-1 text-xl font-bold text-card-foreground">{data?.redeemedCount || 0}</div>
              </div>
            </div>
            <div className="bg-accent/30 rounded-xl p-4 border border-border shadow-lg">
              <div>
                <div className="text-sm font-medium text-muted-foreground">Redemption Value</div>
                <div className="mt-1 text-xl font-bold text-card-foreground">{formatCurrency(data?.redeemedAmount || 0)}</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
