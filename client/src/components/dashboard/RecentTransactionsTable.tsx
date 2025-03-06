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
    
    // Use our timezone-aware formatter with Eastern timezone
    const EASTERN_TIMEZONE = 'America/New_York';
    const today = new Date();
    
    // Format both dates in Eastern timezone for comparison
    const dateInEastern = formatInTimezone(date, "yyyy-MM-dd", EASTERN_TIMEZONE);
    const todayInEastern = formatInTimezone(today, "yyyy-MM-dd", EASTERN_TIMEZONE);
    
    const isToday = dateInEastern === todayInEastern;
    
    if (isToday) {
      return formatInTimezone(date, "h:mm a", EASTERN_TIMEZONE);
    } else {
      return formatInTimezone(date, "M/d h:mm a", EASTERN_TIMEZONE);
    }
  };

  const formatCategory = (category: string) => {
    return category === 'giftCard' ? 'Gift Card' : category.charAt(0).toUpperCase() + category.slice(1);
  };

  return (
    <Card className="bg-black/30 backdrop-blur-sm border border-white/10 shadow-xl rounded-xl overflow-hidden">
      <CardHeader className="px-4 py-5 sm:px-6 flex justify-between items-center border-b border-white/10">
        <CardTitle className="text-lg leading-6 font-medium text-white">Recent Transactions</CardTitle>
        <div className="ml-4 flex-shrink-0">
          <a href="#" className="font-medium text-primary hover:text-primary/80">View all</a>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-hidden overflow-x-auto">
          <Table>
            <TableHeader className="bg-black/50">
              <TableRow className="border-b border-white/10">
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-white/70 uppercase tracking-wider">
                  Time
                </TableHead>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-white/70 uppercase tracking-wider">
                  Amount
                </TableHead>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-white/70 uppercase tracking-wider">
                  Category
                </TableHead>
                <TableHead className="px-6 py-3 text-left text-xs font-medium text-white/70 uppercase tracking-wider">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="bg-transparent divide-y divide-white/10">
              {isLoading ? (
                Array(5).fill(0).map((_, index) => (
                  <TableRow key={index} className="border-b border-white/10">
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-16 bg-white/10" />
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-24 bg-white/10" />
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-20 bg-white/10" />
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap">
                      <Skeleton className="h-5 w-24 bg-white/10" />
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                data?.slice(0, 5).map((transaction, index) => (
                  <TableRow key={index} className="border-b border-white/10">
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-white/80">
                      {formatTime(transaction)}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">
                      {formatCurrency(transaction.amount)}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm text-white/80">
                      {formatCategory(transaction.categoryId)}
                    </TableCell>
                    <TableCell className="px-6 py-4 whitespace-nowrap text-sm">
                      <Badge variant="outline" className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                        transaction.status === 'completed' 
                          ? 'bg-green-500/20 text-green-400 border-green-500/30' 
                          : transaction.status === 'refunded'
                          ? 'bg-red-600/20 text-red-400 border-red-600/30'
                          : 'bg-white/10 text-white/80 border-white/20'
                      }`}>
                        {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
