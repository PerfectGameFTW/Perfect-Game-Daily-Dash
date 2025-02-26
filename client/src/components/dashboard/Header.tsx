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
    <div className="px-4 pt-8 pb-0">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-white">Perfect Game</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="icon" className="bg-zinc-800 border-none rounded-md hover:bg-zinc-700">
            <Settings className="h-5 w-5 text-zinc-300" />
          </Button>
          <Button variant="outline" size="icon" className="bg-zinc-800 border-none rounded-md hover:bg-zinc-700">
            <Bell className="h-5 w-5 text-zinc-300" />
          </Button>
        </div>
      </div>
      
      <Button 
        variant="outline" 
        className="w-full justify-between h-12 px-4 py-2 text-md border border-zinc-800 rounded-md bg-zinc-900 mb-6 hover:bg-zinc-800"
        onClick={onOpenTimeframeModal}
      >
        <ChevronLeft className="h-5 w-5 text-zinc-400" />
        <span className="flex-1 text-center text-white">{displayDate}</span>
        <ChevronRight className="h-5 w-5 text-zinc-400" />
      </Button>
      
      <div className="flex justify-end mb-2">
        <Button variant="outline" size="icon" className="bg-zinc-800 border-none rounded-md hover:bg-zinc-700">
          <Filter className="h-5 w-5 text-zinc-300" />
        </Button>
      </div>
    </div>
  );
}
