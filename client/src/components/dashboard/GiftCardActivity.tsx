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
            'rgba(249, 168, 212, 0.9)', // pink-500 with alpha
            'rgba(129, 140, 248, 0.9)'  // indigo-500 with alpha
          ],
          borderColor: [
            'rgba(249, 168, 212, 1)', // pink-500
            'rgba(129, 140, 248, 1)'  // indigo-500
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

  return (
    <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl overflow-hidden">
      <div className="flex flex-row items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-xl font-bold flex items-center text-white">
            <CreditCard size={20} className="mr-2 text-pink-400" />
            <span>Gift Card Activity</span>
          </h2>
          {data && !isLoading && (
            <div className="flex items-center text-white/70 text-sm">
              <TrendingUp size={16} className="mr-1 text-green-400" />
              <span>Total sales: {formatCurrency(data?.soldAmount || 0)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center px-3 py-1.5 bg-pink-500/10 text-pink-400 rounded-lg text-sm font-medium">
          <CreditCard size={14} className="mr-1.5" />
          <span>Gift Cards</span>
        </div>
      </div>
      
      {isLoading ? (
        <>
          <div className="mt-6 h-64 flex items-center justify-center">
            <Skeleton className="h-4/5 w-4/5 rounded-full" />
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4">
            {Array(4).fill(0).map((_, index) => (
              <div key={index} className="bg-white/5 rounded-lg p-4">
                <Skeleton className="h-5 w-24 mb-2" />
                <Skeleton className="h-7 w-16" />
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-4 flex items-center justify-between mb-4">
            <h4 className="text-base font-medium text-white/90">
              {dateRange === 'yesterday' ? 'Gift Card Sales Yesterday' : 'Gift Card Sales Today'}
            </h4>
            <span className="text-2xl font-bold text-pink-400">{formatCurrency(data?.soldAmount || 0)}</span>
          </div>
          
          {/* Donut Chart for Gift Card Sales vs Redemptions */}
          <div className="mt-2 h-64">
            <canvas ref={chartRef}></canvas>
            
            {/* Horizontal bars showing percentages */}
            <div className="mt-4 space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-white/70">Gift Card Sales</span>
                  <span className="font-semibold text-white">{formatCurrency(data?.soldAmount || 0)}</span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-pink-500 rounded-full" 
                    style={{ 
                      width: `${data?.soldAmount ? Math.min(100, (data.soldAmount / (data.soldAmount + data.redeemedAmount + 0.01)) * 100) : 0}%` 
                    }} 
                  />
                </div>
              </div>
              
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-white/70">Gift Card Redemptions</span>
                  <span className="font-semibold text-white">{formatCurrency(data?.redeemedAmount || 0)}</span>
                </div>
                <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-indigo-500 rounded-full" 
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
            <div className="bg-white/5 rounded-xl p-4 border border-white/10 shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-pink-500/20 flex items-center justify-center mr-3">
                  <CreditCard className="h-4 w-4 text-pink-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white/60">Cards Sold</div>
                  <div className="mt-1 text-xl font-bold text-white">{data?.soldCount || 0}</div>
                </div>
              </div>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10 shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-indigo-500/20 flex items-center justify-center mr-3">
                  <RefreshCcw className="h-4 w-4 text-indigo-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white/60">Cards Redeemed</div>
                  <div className="mt-1 text-xl font-bold text-white">{data?.redeemedCount || 0}</div>
                </div>
              </div>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10 shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-green-500/20 flex items-center justify-center mr-3">
                  <DollarSign className="h-4 w-4 text-green-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white/60">Avg. Card Value</div>
                  <div className="mt-1 text-xl font-bold text-white">{formatCurrency(data?.averageValue || 0)}</div>
                </div>
              </div>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10 shadow-lg">
              <div className="flex items-center">
                <div className="h-8 w-8 rounded-lg bg-orange-500/20 flex items-center justify-center mr-3">
                  <TrendingUp className="h-4 w-4 text-orange-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white/60">Redemption Value</div>
                  <div className="mt-1 text-xl font-bold text-white">{formatCurrency(data?.redeemedAmount || 0)}</div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
