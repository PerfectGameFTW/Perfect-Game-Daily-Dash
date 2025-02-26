import { Settings, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRange } from "@shared/schema";
import { format } from "date-fns";

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
      ? `Today, ${format(today, 'MMM d')}`
      : dateRange === 'yesterday'
        ? `Yesterday, ${format(new Date(today.setDate(today.getDate() - 1)), 'MMM d')}`
        : dateRange === 'thisMonth'
          ? `This Month`
          : dateRange === 'last7days'
            ? 'This Week'
            : dateRange === 'last30days'
              ? 'This Year'
              : `Custom Range`;

  return (
    <header className="border-b border-zinc-800 px-4 py-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center">
          <h1 className="text-lg font-semibold text-white">Perfect Game</h1>
        </div>
        <Button 
          variant="ghost"
          size="sm"
          className="text-zinc-400 hover:text-white hover:bg-transparent"
        >
          <Settings className="h-5 w-5" />
        </Button>
      </div>
      
      <div 
        className="flex justify-center items-center py-3 mt-2 cursor-pointer"
        onClick={onOpenTimeframeModal}
      >
        <div className="flex items-center">
          <ChevronLeft className="h-5 w-5 text-blue-400" />
          <span className="text-center font-medium text-white mx-3">{displayDate}</span>
          <ChevronRight className="h-5 w-5 text-blue-400" />
        </div>
      </div>
    </header>
  );
}
