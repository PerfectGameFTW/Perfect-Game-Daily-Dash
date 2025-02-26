import { ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { DateRange } from "@shared/schema";
import { format } from "date-fns";
import { navigateDate, getFormattedDate } from "@/lib/dateUtils";

interface HeaderProps {
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
  onDateRangeChange: (range: DateRange, start?: Date, end?: Date) => void;
  onOpenTimeframeModal: () => void;
}

export default function Header({ 
  dateRange, 
  customStartDate, 
  customEndDate, 
  onDateRangeChange,
  onOpenTimeframeModal
}: HeaderProps) {
  // Format the current display date
  const today = new Date();
  const displayDate = dateRange === 'custom' && customStartDate && customEndDate 
    ? `${format(customStartDate, 'MMM d')} - ${format(customEndDate, 'MMM d')}` 
    : dateRange === 'today' 
      ? customStartDate 
        ? `${format(customStartDate, 'MMM d')}`
        : `Today, ${format(today, 'MMM d')}`
      : dateRange === 'yesterday'
        ? `Yesterday, ${format(new Date(new Date().setDate(today.getDate() - 1)), 'MMM d')}`
        : dateRange === 'thisMonth'
          ? `This Month`
          : dateRange === 'last7days'
            ? 'This Week'
            : dateRange === 'last30days'
              ? 'This Year'
              : `Custom Range`;

  const handlePrevDate = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent the drawer from opening
    const result = navigateDate('prev', dateRange, customStartDate, customEndDate);
    onDateRangeChange(result.dateRange, result.startDate, result.endDate);
  };

  const handleNextDate = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent the drawer from opening
    const result = navigateDate('next', dateRange, customStartDate, customEndDate);
    onDateRangeChange(result.dateRange, result.startDate, result.endDate);
  };

  return (
    <header className="border-b border-zinc-800 px-4 py-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center">
          <h1 className="text-2xl font-bold text-white">Perfect Game</h1>
        </div>
      </div>
      
      <div className="flex justify-center items-center py-3 mt-2">
        <div className="flex items-center">
          <div
            className="p-2 cursor-pointer hover:bg-zinc-800 rounded-full transition-colors"
            onClick={handlePrevDate}
          >
            <ChevronLeft className="h-5 w-5 text-blue-400" />
          </div>
          
          <span 
            className="text-center font-medium text-white mx-3 cursor-pointer px-3 py-1 hover:bg-zinc-800 rounded-md transition-colors"
            onClick={onOpenTimeframeModal}
          >
            {displayDate}
          </span>
          
          <div
            className="p-2 cursor-pointer hover:bg-zinc-800 rounded-full transition-colors"
            onClick={handleNextDate}
          >
            <ChevronRight className="h-5 w-5 text-blue-400" />
          </div>
        </div>
      </div>
    </header>
  );
}
