import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { DateRange } from "@shared/schema";
import { format, isSameDay, subDays } from "date-fns";
import { navigateDate, getFormattedDate } from "@/lib/dateUtils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
  
  let displayDate;
  
  if (customStartDate) {
    // If we have a custom start date, always use it for display
    if (customEndDate && !isSameDay(customStartDate, customEndDate)) {
      displayDate = `${format(customStartDate, 'MMM d')} - ${format(customEndDate, 'MMM d')}`;
    } else {
      displayDate = format(customStartDate, 'MMM d, yyyy');
    }
  } else {
    // Fall back to standard labels when no custom date is set
    displayDate = dateRange === 'today' 
      ? `Today, ${format(today, 'MMM d')}`
      : dateRange === 'yesterday'
        ? `Yesterday, ${format(subDays(new Date(), 1), 'MMM d')}`
        : dateRange === 'thisMonth'
          ? `This Month`
          : dateRange === 'last7days'
            ? 'This Week'
            : dateRange === 'last30days'
              ? 'This Year'
              : dateRange === 'custom' && !customStartDate
                ? 'Custom Range'
                : format(today, 'MMM d, yyyy');
  }
  
  console.log('Display date:', {
    displayDate,
    dateRange,
    customStartDate: customStartDate?.toISOString(),
    customEndDate: customEndDate?.toISOString()
  });

  const handlePrevDate = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent the drawer from opening
    console.log('Clicked previous arrow, current state:', {
      dateRange,
      customStartDate: customStartDate?.toISOString(),
      customEndDate: customEndDate?.toISOString()
    });
    
    const result = navigateDate('prev', dateRange, customStartDate, customEndDate);
    
    console.log('Navigation result:', {
      newDateRange: result.dateRange,
      newStartDate: result.startDate?.toISOString(),
      newEndDate: result.endDate?.toISOString()
    });
    
    onDateRangeChange(result.dateRange, result.startDate, result.endDate);
  };

  const handleNextDate = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent the drawer from opening
    console.log('Clicked next arrow, current state:', {
      dateRange,
      customStartDate: customStartDate?.toISOString(),
      customEndDate: customEndDate?.toISOString()
    });
    
    const result = navigateDate('next', dateRange, customStartDate, customEndDate);
    
    console.log('Navigation result:', {
      newDateRange: result.dateRange,
      newStartDate: result.startDate?.toISOString(),
      newEndDate: result.endDate?.toISOString()
    });
    
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
        <div className="flex items-center bg-zinc-900 p-1 rounded-lg shadow-md">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-2 cursor-pointer hover:bg-zinc-800 rounded-full transition-colors"
                  onClick={handlePrevDate}
                  aria-label="Previous date"
                >
                  <ChevronLeft className="h-5 w-5 text-blue-400" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Previous {dateRange === 'today' ? 'day' : dateRange === 'last7days' ? 'week' : dateRange === 'thisMonth' ? 'month' : 'period'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          
          <button 
            className="flex items-center gap-2 text-center font-medium text-white mx-2 cursor-pointer px-4 py-1.5 hover:bg-zinc-800 rounded-md transition-colors"
            onClick={onOpenTimeframeModal}
          >
            <Calendar className="h-4 w-4 text-blue-400" />
            <span>{displayDate}</span>
          </button>
          
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="p-2 cursor-pointer hover:bg-zinc-800 rounded-full transition-colors"
                  onClick={handleNextDate}
                  aria-label="Next date"
                >
                  <ChevronRight className="h-5 w-5 text-blue-400" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>Next {dateRange === 'today' ? 'day' : dateRange === 'last7days' ? 'week' : dateRange === 'thisMonth' ? 'month' : 'period'}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </header>
  );
}
