import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle 
} from "@/components/ui/card";
import { useQuery } from "@tanstack/react-query";
import { fetchTransactions } from "@/lib/squareApi";
import { DateRange } from "@shared/schema";
import { formatCurrency, formatInTimezone } from "@/lib/dateUtils";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

interface RecentTransactionsTableProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
}

export default function RecentTransactionsTable({ 
  dateRange, 
  customStartDate, 
  customEndDate 
}: RecentTransactionsTableProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/transactions', dateRange, customStartDate?.toISOString(), customEndDate?.toISOString()],
    queryFn: () => fetchTransactions(dateRange, customStartDate, customEndDate),
  });

  // Format transaction time in Eastern timezone
  const formatTime = (transaction: any) => {
    const timestamp = transaction.timestamp;
    
    // Handle various timestamp formats
    let date: Date;
    if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else {
      console.error("Unexpected timestamp format:", timestamp);
      return "Unknown time";
    }
    
    // Use our timezone-aware formatter with date included for clarity
    // This ensures we show both date and time in Eastern timezone
    const today = new Date();
    const isToday = formatInTimezone(date, "yyyy-MM-dd") === formatInTimezone(today, "yyyy-MM-dd");
    
    if (isToday) {
      return formatInTimezone(date, "h:mm a");
    } else {
      return formatInTimezone(date, "M/d h:mm a");
    }
  };

  const formatCategory = (category: string) => {
    return category === 'giftCard' ? 'Gift Card' : category.charAt(0).toUpperCase() + category.slice(1);
  };

  return (
    <Card className="shadow overflow-hidden sm:rounded-lg dashboard-card hover:shadow-lg transition-all duration-200 transform hover:-translate-y-1">
      <CardHeader className="px-4 py-5 sm:px-6 flex justify-between items-center border-b border-gray-200">
        <CardTitle className="text-lg leading-6 font-medium text-gray-900">Recent Transactions</CardTitle>
        <div className="ml-4 flex-shrink-0">
          <a href="#" className="font-medium text-primary hover:text-blue-700">View all</a>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-hidden overflow-x-auto">
          <Table>
            <TableHeader className="bg-gray-50">
              <TableRow>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Time
                </TableHead>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </TableHead>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Category
                </TableHead>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="bg-white divide-y divide-gray-200">
              {isLoading ? (
                Array(5).fill(0).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-16" />
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-24" />
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-20" />
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-24" />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                data?.slice(0, 5).map((transaction, index) => (
                  <TableRow key={index}>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatTime(transaction)}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {formatCurrency(transaction.amount)}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatCategory(transaction.categoryId)}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <Badge variant="outline" className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        transaction.status === 'completed' 
                          ? 'bg-green-100 text-green-800' 
                          : transaction.status === 'refunded'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-gray-100 text-gray-800'
                      }`}>
                        {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
