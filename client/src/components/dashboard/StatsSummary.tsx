import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchDailySummary, fetchDetailedTransactions } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatPercentage, isPositiveChange } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import SimpleBarChart from "./SimpleBarChart";
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
  Wallet,
  Info
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StatsSummaryProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function StatsSummary({ dateRange, customStartDate, customEndDate }: StatsSummaryProps) {
  const isLiveRange = dateRange === 'today' || dateRange === 'yesterday';

  const { data, isLoading } = useQuery({
    queryKey: ['/api/summary', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDailySummary(dateRange, customStartDate, customEndDate),
    retry: 1,
    retryDelay: 1000,
    refetchInterval: isLiveRange ? 60_000 : false,
  });

  const { data: detailedTransactions, isLoading: isDetailedLoading } = useQuery({
    queryKey: ['/api/detailed-transactions', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchDetailedTransactions(dateRange, customStartDate, customEndDate),
    retry: 1,
    retryDelay: 1000,
    refetchInterval: isLiveRange ? 60_000 : false,
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

  // Ensure we're working with numbers even if API returns strings
  const totalRevenue = typeof data?.totalRevenue === 'number' ? data?.totalRevenue : parseFloat(data?.totalRevenue || '0');
  const refunds = typeof detailedTransactions?.refunds === 'number' ? detailedTransactions?.refunds : parseFloat(detailedTransactions?.refunds || '0');
  const discounts = typeof detailedTransactions?.discountsAndComps === 'number' ? detailedTransactions?.discountsAndComps : parseFloat(detailedTransactions?.discountsAndComps || '0');
  const depositClearings = typeof detailedTransactions?.depositClearings === 'number' ? detailedTransactions?.depositClearings : parseFloat(String(detailedTransactions?.depositClearings ?? 0));
  const tips = typeof detailedTransactions?.tips === 'number' ? detailedTransactions?.tips : parseFloat(String(detailedTransactions?.tips ?? 0));
  const serviceCharges = typeof detailedTransactions?.serviceCharges === 'number' ? detailedTransactions?.serviceCharges : parseFloat(String(detailedTransactions?.serviceCharges ?? 0));
  const taxes = typeof detailedTransactions?.taxes === 'number' ? detailedTransactions?.taxes : parseFloat(String(detailedTransactions?.taxes ?? 0));
  
  const calculatedNetRevenue = totalRevenue - refunds - discounts - depositClearings - tips - serviceCharges - taxes;

  return (
    <div className="mt-4 space-y-6">
      {/* Revenue Highlights - Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* Total Revenue Card */}
        <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="text-sm font-medium text-muted-foreground">Total Revenue</h3>
                {dateRange === 'today' && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                        Includes all authorized payments + tips captured today. Square's dashboard may show slightly less until tonight's tip settlements clear (~overnight).
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
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
        <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <h3 className="text-sm font-medium text-muted-foreground">Gift Card Sales</h3>
              <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(data?.giftCardSales || 0)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Gift className="h-6 w-6 text-primary" />
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
            <span className="ml-2 text-xs text-muted-foreground">vs. previous period</span>
          </div>
        </div>
        
        {/* Tips */}
        <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <h3 className="text-sm font-medium text-muted-foreground">Tips</h3>
              <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(detailedTransactions?.tips || 0)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <BadgeDollarSign className="h-6 w-6 text-primary" />
            </div>
          </div>
          
          <div className="mt-4 flex items-center">
            <span className="text-xs text-muted-foreground">
              {(detailedTransactions?.tips || 0) > 0 
                ? `${((detailedTransactions?.tips || 0) / (data?.totalRevenue || 1) * 100).toFixed(1)}% of sales` 
                : "No tips in this period"}
            </span>
          </div>
        </div>
        
        {/* Net Sales */}
        <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl transition-all hover:border-primary/20 hover:shadow-primary/5">
          <div className="flex justify-between">
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="text-sm font-medium text-muted-foreground">Net Sales</h3>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[260px] text-xs space-y-1">
                      <p className="font-semibold mb-1">Net Sales = Total Revenue − Event Deposit Redemptions − Tips − Service Charges − Taxes − Discounts & Comps − Refunds</p>
                      {depositClearings > 0 && <p>Event Deposit Redemptions: −{formatCurrency(depositClearings)}</p>}
                      {tips > 0 && <p>Tips: −{formatCurrency(tips)}</p>}
                      {serviceCharges > 0 && <p>Service Charges: −{formatCurrency(serviceCharges)}</p>}
                      {taxes > 0 && <p>Taxes: −{formatCurrency(taxes)}</p>}
                      {discounts > 0 && <p>Discounts & Comps: −{formatCurrency(discounts)}</p>}
                      {refunds > 0 && <p>Refunds: −{formatCurrency(refunds)}</p>}
                      {refunds === 0 && discounts === 0 && depositClearings === 0 && tips === 0 && serviceCharges === 0 && taxes === 0 && <p>No deductions in this period.</p>}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="text-3xl font-bold mt-2 text-card-foreground">{formatCurrency(calculatedNetRevenue)}</p>
            </div>
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Wallet className="h-6 w-6 text-primary" />
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
            <span className="ml-2 text-xs text-muted-foreground">vs. gross revenue</span>
          </div>
        </div>
      </div>

      {/* Hourly Revenue Chart */}
      <div className="bg-card/80 backdrop-blur-sm p-6 rounded-xl border border-border shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-card-foreground">Hourly Revenue</h2>
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <TrendingUp className="h-4 w-4 text-primary" />
            <span>Today's pattern</span>
          </div>
        </div>
        <SimpleBarChart
          dateRange={dateRange}
          customStartDate={customStartDate}
          customEndDate={customEndDate}
        />
      </div>

      {/* Summary Section */}
      <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
        
        {/* Summary Stats */}
        <div className="bg-gradient-to-br from-primary/20 to-primary/5 backdrop-blur-sm p-6 rounded-xl border border-primary/20 shadow-xl">
          <h2 className="text-xl font-bold mb-6 text-card-foreground">Summary Stats</h2>
          
          <div className="space-y-5">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Gross Revenue</span>
              <span className="text-card-foreground font-medium">{formatCurrency(data?.totalRevenue || 0)}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Event Deposit Redemptions</span>
              <span className="text-card-foreground font-medium">({formatCurrency(depositClearings)})</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Tips</span>
              <span className="text-card-foreground font-medium">({formatCurrency(tips)})</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Service Charges</span>
              <span className="text-card-foreground font-medium">({formatCurrency(serviceCharges)})</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Taxes</span>
              <span className="text-card-foreground font-medium">({formatCurrency(taxes)})</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Discounts & Comps</span>
              <span className="text-card-foreground font-medium">({formatCurrency(discounts)})</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Refunds</span>
              <span className="text-card-foreground font-medium">({formatCurrency(refunds)})</span>
            </div>

            <div className="flex justify-between items-center pt-3 border-t border-border">
              <span className="text-card-foreground font-medium">Net Revenue</span>
              <span className="text-card-foreground font-medium">{formatCurrency(calculatedNetRevenue)}</span>
            </div>

            <div className="flex justify-between items-center pt-3 border-t border-border">
              <span className="text-muted-foreground">Bowling Web Res Deposits</span>
              <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.bowlingWebResDeposits || 0)}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Laser Tag Web Res Deposits</span>
              <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.laserTagWebResDeposits || 0)}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Gift Card Sales</span>
              <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.giftCardSales || 0)}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Partywirks Deposits</span>
              <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.partywirks || 0)}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Tripleseat Deposits</span>
              <span className="text-card-foreground font-medium">{formatCurrency(detailedTransactions?.tripleseat || 0)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}