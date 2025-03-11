import { useQuery } from "@tanstack/react-query";
import { fetchDailySummary, fetchDetailedTransactions } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatPercentage, isPositiveChange } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import SimpleHourlyChart from "./SimpleHourlyChart";
import {
  ChevronUp,
  ChevronDown,
  TrendingUp,
  DollarSign,
  Gift,
  Users,
  Receipt,
  Tag,
  CreditCard,
  BadgeDollarSign,
  Percent,
  Award,
  Wallet
} from "lucide-react";

interface StatsSummaryProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function StatsSummary({ dateRange, customStartDate, customEndDate }: StatsSummaryProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/summary', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDailySummary(dateRange, customStartDate, customEndDate),
  });

  const { data: detailedTransactions, isLoading: isDetailedLoading } = useQuery({
    queryKey: ['/api/detailed-transactions', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDetailedTransactions(dateRange, customStartDate, customEndDate),
  });

  if (isLoading || isDetailedLoading) {
    return (
      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-36 w-full rounded-xl md:col-span-2" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl md:col-span-3" />
      </div>
    );
  }

  // Calculate adjusted sales (some items may need to be subtracted)
  const calculatedNetRevenue = (data?.totalRevenue || 0) - 
    (detailedTransactions?.refunds || 0) - 
    (detailedTransactions?.discountsAndComps || 0);

  return (
    <div className="mt-4 space-y-6">
      {/* Revenue Highlights - Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Total Revenue Card */}
        <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <h3 className="text-sm font-medium text-muted-foreground">Total Revenue</h3>
              <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(data?.totalRevenue || 0)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <DollarSign className="h-6 w-6 text-primary" />
            </div>
          </div>
          
          <div className="mt-4 flex items-center">
            <div
              className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
                isPositiveChange(data?.revenueChange || 0)
                  ? "bg-green-500/10 text-green-400"
                  : "bg-red-500/10 text-red-400"
              }`}
            >
              {isPositiveChange(data?.revenueChange || 0) ? (
                <ChevronUp className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              )}
              {formatPercentage(Math.abs(data?.revenueChange || 0))}
            </div>
            <span className="ml-2 text-xs text-muted-foreground">vs. previous period</span>
          </div>
        </div>

        {/* Gift Card Sales */}
        <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <h3 className="text-sm font-medium text-white/70">Gift Card Sales</h3>
              <p className="text-3xl font-bold mt-2 text-white">{formatCurrency(data?.giftCardSales || 0)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-red-600/10 flex items-center justify-center">
              <Gift className="h-6 w-6 text-red-600" />
            </div>
          </div>
          
          <div className="mt-4 flex items-center">
            <div
              className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
                isPositiveChange(data?.giftCardSalesChange || 0)
                  ? "bg-green-500/10 text-green-400"
                  : "bg-red-500/10 text-red-400"
              }`}
            >
              {isPositiveChange(data?.giftCardSalesChange || 0) ? (
                <ChevronUp className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              )}
              {formatPercentage(Math.abs(data?.giftCardSalesChange || 0))}
            </div>
            <span className="ml-2 text-xs text-white/60">vs. previous period</span>
          </div>
        </div>
        
        {/* Tips */}
        <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <h3 className="text-sm font-medium text-white/70">Tips</h3>
              <p className="text-3xl font-bold mt-2 text-white">{formatCurrency(detailedTransactions?.tips || 0)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-red-600/10 flex items-center justify-center">
              <BadgeDollarSign className="h-6 w-6 text-red-600" />
            </div>
          </div>
          
          <div className="mt-4 flex items-center">
            <span className="text-xs text-white/60">
              {(detailedTransactions?.tips || 0) > 0 
                ? `${((detailedTransactions?.tips || 0) / (data?.totalRevenue || 1) * 100).toFixed(1)}% of sales` 
                : "No tips in this period"}
            </span>
          </div>
        </div>
        
        {/* Net Sales */}
        <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <h3 className="text-sm font-medium text-white/70">Net Sales</h3>
              <p className="text-3xl font-bold mt-2 text-white">{formatCurrency(calculatedNetRevenue)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-red-600/10 flex items-center justify-center">
              <Wallet className="h-6 w-6 text-red-600" />
            </div>
          </div>
          
          <div className="mt-4 flex items-center">
            <div
              className={`px-2 py-1 rounded-lg text-xs font-semibold flex items-center ${
                calculatedNetRevenue < (data?.totalRevenue || 0)
                  ? "bg-amber-500/10 text-amber-400"
                  : "bg-green-500/10 text-green-400"
              }`}
            >
              {calculatedNetRevenue < (data?.totalRevenue || 0) ? (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronUp className="mr-0.5 h-3 w-3" />
              )}
              {formatPercentage(Math.abs(1 - (calculatedNetRevenue / (data?.totalRevenue || 1))))}
            </div>
            <span className="ml-2 text-xs text-white/60">vs. gross revenue</span>
          </div>
        </div>
      </div>

      {/* Hourly Revenue Chart */}
      <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-white">Hourly Revenue</h2>
          <div className="flex items-center gap-2 text-white/70 text-sm">
            <TrendingUp className="h-4 w-4 text-primary" />
            <span>Today's pattern</span>
          </div>
        </div>
        <SimpleHourlyChart
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
      </div>

      {/* Detailed Metrics & Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-black/30 backdrop-blur-sm p-6 rounded-xl border border-white/10 shadow-xl md:col-span-2">
          <h2 className="text-xl font-bold mb-4 text-white">Revenue Breakdown</h2>
          
          <div className="space-y-4">
            {/* Service Payments Section */}
            <div className="border-b border-white/10 pb-3">
              <h3 className="text-sm font-medium mb-3 text-white/70">Service Payments</h3>
              
              <div className="grid grid-cols-2 gap-4">
                {/* Partywirks */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-lg bg-red-600/10 flex items-center justify-center mr-3">
                      <Users className="h-4 w-4 text-red-600" />
                    </div>
                    <span className="text-sm text-white">Partywirks</span>
                  </div>
                  <span className="font-medium text-white">{formatCurrency(detailedTransactions?.partywirks || 0)}</span>
                </div>
                
                {/* Tripleseat */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-lg bg-white/10 flex items-center justify-center mr-3">
                      <Receipt className="h-4 w-4 text-white" />
                    </div>
                    <span className="text-sm text-white">Tripleseat</span>
                  </div>
                  <span className="font-medium text-white">{formatCurrency(detailedTransactions?.tripleseat || 0)}</span>
                </div>
              </div>
            </div>
            
            {/* Additional Charges Section */}
            <div className="border-b border-white/10 pb-3">
              <h3 className="text-sm font-medium mb-3 text-white/70">Additional Charges</h3>
              
              <div className="grid grid-cols-2 gap-4">
                {/* Service Charges */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-lg bg-red-600/10 flex items-center justify-center mr-3">
                      <Tag className="h-4 w-4 text-red-600" />
                    </div>
                    <span className="text-sm text-white">Service Charges</span>
                  </div>
                  <span className="font-medium text-white">{formatCurrency(detailedTransactions?.serviceCharges || 0)}</span>
                </div>
                
                {/* Taxes */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-lg bg-white/10 flex items-center justify-center mr-3">
                      <CreditCard className="h-4 w-4 text-white" />
                    </div>
                    <span className="text-sm text-white">Taxes</span>
                  </div>
                  <span className="font-medium text-white">{formatCurrency(detailedTransactions?.taxes || 0)}</span>
                </div>
              </div>
            </div>
            
            {/* Adjustments Section */}
            <div>
              <h3 className="text-sm font-medium mb-3 text-white/70">Adjustments</h3>
              
              <div className="grid grid-cols-2 gap-4">
                {/* Refunds */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-lg bg-red-600/10 flex items-center justify-center mr-3">
                      <Award className="h-4 w-4 text-red-600" />
                    </div>
                    <span className="text-sm text-white">Refunds</span>
                  </div>
                  <span className="font-medium text-white">{formatCurrency(detailedTransactions?.refunds || 0)}</span>
                </div>
                
                {/* Discounts & Comps */}
                <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div className="flex items-center">
                    <div className="h-8 w-8 rounded-lg bg-white/10 flex items-center justify-center mr-3">
                      <Percent className="h-4 w-4 text-white" />
                    </div>
                    <span className="text-sm text-white">Discounts & Comps</span>
                  </div>
                  <span className="font-medium text-white">{formatCurrency(detailedTransactions?.discountsAndComps || 0)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Summary Stats */}
        <div className="bg-gradient-to-br from-primary/20 to-primary/5 backdrop-blur-sm p-6 rounded-xl border border-primary/20 shadow-xl">
          <h2 className="text-xl font-bold mb-6 text-white">Summary Stats</h2>
          
          <div className="space-y-5">
            <div className="flex justify-between items-center">
              <span className="text-white/80">Orders</span>
              <span className="text-white font-medium">{data?.totalOrders || 0}</span>
            </div>
            
            <div className="flex justify-between items-center">
              <span className="text-white/80">Average Order</span>
              <span className="text-white font-medium">
                {data?.totalOrders && data.totalOrders > 0 
                  ? formatCurrency((data?.totalRevenue || 0) / data.totalOrders) 
                  : formatCurrency(0)}
              </span>
            </div>
            
            <div className="flex justify-between items-center">
              <span className="text-white/80">Gift Card Sales</span>
              <span className="text-white font-medium">{formatCurrency(data?.giftCardSales || 0)}</span>
            </div>
            
            <div className="flex justify-between items-center">
              <span className="text-white/80">Gross Revenue</span>
              <span className="text-white font-medium">{formatCurrency(data?.totalRevenue || 0)}</span>
            </div>
            
            <div className="flex justify-between items-center">
              <span className="text-white/80">Taxes & Fees</span>
              <span className="text-white font-medium">
                {formatCurrency((detailedTransactions?.taxes || 0) + (detailedTransactions?.serviceCharges || 0))}
              </span>
            </div>
            
            <div className="flex justify-between items-center">
              <span className="text-white/80">Discounts</span>
              <span className="text-white font-medium">{formatCurrency(detailedTransactions?.discountsAndComps || 0)}</span>
            </div>
            
            <div className="flex justify-between items-center pt-3 border-t border-white/10">
              <span className="text-white font-medium">Net Revenue</span>
              <span className="text-white font-medium">{formatCurrency(calculatedNetRevenue)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}