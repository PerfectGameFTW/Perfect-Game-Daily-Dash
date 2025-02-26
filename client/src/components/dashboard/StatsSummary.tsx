import { useQuery } from "@tanstack/react-query";
import { fetchDailySummary } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatPercentage, isPositiveChange } from "@/lib/dateUtils";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  DollarSign, 
  ShoppingBag, 
  BarChart2, 
  GiftIcon, 
  ChevronUp, 
  ChevronDown 
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

  const statsItems = [
    {
      title: "Total Revenue",
      value: data?.totalRevenue || 0,
      change: data?.revenueChange || 0,
      icon: DollarSign,
      color: "bg-primary",
    },
    {
      title: "Total Orders",
      value: data?.totalOrders || 0,
      change: data?.ordersChange || 0,
      icon: ShoppingBag,
      color: "bg-secondary",
      isCurrency: false,
    },
    {
      title: "Average Order",
      value: data?.averageOrder || 0,
      change: data?.averageOrderChange || 0,
      icon: BarChart2,
      color: "bg-accent",
    },
    {
      title: "Gift Card Sales",
      value: data?.giftCardSales || 0,
      change: data?.giftCardSalesChange || 0,
      icon: GiftIcon,
      color: "bg-amber-500",
    },
  ];

  return (
    <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {statsItems.map((item, index) => (
        <Card key={index} className="overflow-hidden shadow dashboard-card hover:shadow-lg transition-all duration-200 transform hover:-translate-y-1">
          <CardContent className="p-0">
            <div className="px-4 py-5 sm:p-6">
              <div className="flex items-center">
                <div className={`flex-shrink-0 ${item.color} rounded-md p-3`}>
                  <item.icon className="h-6 w-6 text-white" />
                </div>
                <div className="ml-5 w-0 flex-1">
                  {isLoading ? (
                    <>
                      <Skeleton className="h-5 w-24 mb-2" />
                      <Skeleton className="h-7 w-36 mb-1" />
                      <Skeleton className="h-5 w-16" />
                    </>
                  ) : (
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {item.title}
                      </dt>
                      <dd className="flex items-baseline">
                        <div className="text-2xl font-semibold text-gray-900">
                          {item.isCurrency === false 
                            ? item.value 
                            : formatCurrency(item.value)}
                        </div>
                        <div className={`ml-2 flex items-baseline text-sm font-semibold ${
                          isPositiveChange(item.change) 
                            ? "text-green-600" 
                            : "text-red-600"
                        }`}>
                          {isPositiveChange(item.change) ? (
                            <ChevronUp className="self-center flex-shrink-0 h-5 w-5 text-green-500" />
                          ) : (
                            <ChevronDown className="self-center flex-shrink-0 h-5 w-5 text-red-500" />
                          )}
                          <span className="sr-only">
                            {isPositiveChange(item.change) ? "Increased" : "Decreased"} by
                          </span>
                          {formatPercentage(Math.abs(item.change))}
                        </div>
                      </dd>
                    </dl>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
