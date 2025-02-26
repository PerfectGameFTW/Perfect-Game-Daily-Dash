import { Settings, Bell, ChevronLeft, ChevronRight, Filter } from "lucide-react";
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
    ? `${format(customStartDate, 'MMM d, yyyy')} - ${format(customEndDate, 'MMM d, yyyy')}` 
    : dateRange === 'today' 
      ? `${format(today, 'MMM d, yyyy')} · All day`
      : dateRange === 'yesterday'
        ? `${format(new Date(today.setDate(today.getDate() - 1)), 'MMM d, yyyy')} · All day`
        : `${dateRange.replace(/([A-Z])/g, ' $1').trim()} · All day`;

  return (
    <div className="p-4 pt-8 pb-0">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-3xl font-bold">Perfect Game</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" className="bg-muted/30 border-none rounded-md">
            <Settings className="h-5 w-5" />
          </Button>
          <Button variant="outline" size="icon" className="bg-muted/30 border-none rounded-md">
            <Bell className="h-5 w-5" />
          </Button>
        </div>
      </div>
      
      <Button 
        variant="outline" 
        className="w-full justify-between h-12 px-4 py-2 text-md border border-border rounded-md bg-muted/20 mb-6"
        onClick={onOpenTimeframeModal}
      >
        <ChevronLeft className="h-5 w-5" />
        <span className="flex-1 text-center">{displayDate}</span>
        <ChevronRight className="h-5 w-5" />
      </Button>
      
      <div className="flex justify-end mb-2">
        <Button variant="outline" size="icon" className="bg-muted/30 border-none rounded-md">
          <Filter className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
