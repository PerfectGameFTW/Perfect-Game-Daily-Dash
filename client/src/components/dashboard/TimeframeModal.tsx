import { useState, useEffect } from "react";
import { 
  Drawer, 
  DrawerContent, 
  DrawerHeader, 
  DrawerTitle,
  DrawerClose
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { DateRange } from "@shared/schema";
import { ChevronRight, Calendar } from "lucide-react";
import { format, addDays, isAfter, isBefore, isSameDay } from "date-fns";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";

interface TimeframeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
  onDateRangeChange: (range: DateRange, start?: Date, end?: Date) => void;
}

export default function TimeframeModal({
  open,
  onOpenChange,
  dateRange,
  customStartDate,
  customEndDate,
  onDateRangeChange
}: TimeframeModalProps) {
  const [selectedRange, setSelectedRange] = useState<DateRange>(dateRange);
  const [startDate, setStartDate] = useState<Date | undefined>(customStartDate);
  const [endDate, setEndDate] = useState<Date | undefined>(customEndDate);
  const [calendarOpen, setCalendarOpen] = useState(false);
  
  // Update selected range when dateRange prop changes
  useEffect(() => {
    setSelectedRange(dateRange);
  }, [dateRange]);

  // Update custom dates when props change
  useEffect(() => {
    setStartDate(customStartDate);
    setEndDate(customEndDate);
  }, [customStartDate, customEndDate]);

  const handleSelectRange = (newRange: DateRange) => {
    setSelectedRange(newRange);
    
    // If custom date is selected, keep the drawer open for date selection
    if (newRange === 'custom') {
      // Initialize with current date if no dates are set
      if (!startDate) {
        const today = new Date();
        setStartDate(today);
        setEndDate(today);
      }
      setCalendarOpen(true);
      return;
    }
    
    // For standard date ranges, close the drawer and apply
    onDateRangeChange(newRange);
    onOpenChange(false);
  };

  const handleDateSelect = (date: Date | undefined) => {
    if (!date) return;
    
    if (!startDate || (startDate && endDate)) {
      // Start a new selection
      setStartDate(date);
      setEndDate(undefined);
    } else {
      // Complete the selection
      if (isBefore(date, startDate)) {
        setEndDate(startDate);
        setStartDate(date);
      } else {
        setEndDate(date);
      }
    }
  };

  const handleApplyCustomDates = () => {
    if (startDate && endDate) {
      onDateRangeChange('custom', startDate, endDate);
      onOpenChange(false);
    }
  };

  const timeframes: { label: string, value: DateRange }[] = [
    { label: "Today", value: "today" },
    { label: "Yesterday", value: "yesterday" },
    { label: "This week", value: "last7days" },
    { label: "This month", value: "thisMonth" },
    { label: "Last month", value: "lastMonth" },
    { label: "This year", value: "last30days" },
    { label: "Custom date", value: "custom" },
  ];

  // Format reporting hours (just for display)
  const reportingHours = "All day · 12:00 AM — 11:59 PM EST";
  
  // Custom date selection display
  const getDateRangePreview = () => {
    if (!startDate) return "Select start date";
    if (!endDate) return `From ${format(startDate, "MMM d, yyyy")}`;
    
    if (isSameDay(startDate, endDate)) {
      return format(startDate, "MMMM d, yyyy");
    }
    return `${format(startDate, "MMM d")} - ${format(endDate, "MMM d, yyyy")}`;
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="bg-black border-t border-zinc-800 rounded-t-xl overflow-y-auto" aria-describedby="timeframe-description">
        <DrawerHeader>
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
            <DrawerTitle className="text-xl font-semibold text-white">Timeframe</DrawerTitle>
            <DrawerClose asChild>
              <Button variant="outline" className="bg-zinc-800 border-zinc-700 text-white hover:bg-zinc-700 px-4 py-1 h-auto">
                Done
              </Button>
            </DrawerClose>
          </div>
          <div className="sr-only" id="timeframe-description">
            Select a timeframe for your dashboard data
          </div>
        </DrawerHeader>
        <div className="px-6 py-4 overflow-y-auto">
          {/* Predefined timeframes */}
          {!calendarOpen && (
            <>
              {timeframes.map((timeframe) => (
                <div 
                  key={timeframe.value}
                  className="py-3 border-b border-zinc-800 flex items-center justify-between cursor-pointer"
                  onClick={() => handleSelectRange(timeframe.value)}
                >
                  <span className="text-white">{timeframe.label}</span>
                  {selectedRange === timeframe.value && (
                    <div className="w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-white"></div>
                    </div>
                  )}
                  {selectedRange !== timeframe.value && (
                    <div className="w-5 h-5 rounded-full border border-zinc-600 flex items-center justify-center">
                    </div>
                  )}
                </div>
              ))}

              <div className="mt-4 border border-zinc-800 rounded-lg bg-zinc-900">
                <div className="p-3 flex items-center justify-between">
                  <span className="font-medium text-white">Reporting hours</span>
                  <div className="flex items-center">
                    <span className="text-xs text-zinc-400 mr-2">
                      {reportingHours}
                    </span>
                    <ChevronRight className="h-3 w-3 text-zinc-400" />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Calendar for custom date selection */}
          {calendarOpen && (
            <div className="mt-2">
              <Button 
                variant="ghost" 
                className="mb-4 text-zinc-400 hover:text-white"
                onClick={() => setCalendarOpen(false)}
              >
                ← Back to timeframes
              </Button>
              
              <div className="mb-4">
                <h3 className="text-lg font-medium text-white mb-1">Custom date range</h3>
                <p className="text-zinc-400 text-sm mb-2">
                  {!endDate ? "Select start and end dates" : ""}
                </p>
                <div className="bg-zinc-900 p-3 rounded-md border border-zinc-800">
                  <div className="flex items-center gap-2">
                    <Calendar className="h-5 w-5 text-blue-400" />
                    <span className="text-white">{getDateRangePreview()}</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-zinc-900 p-4 rounded-lg border border-zinc-800">
                <CalendarComponent
                  mode="range"
                  selected={{
                    from: startDate,
                    to: endDate
                  }}
                  onSelect={(range) => {
                    if (range?.from) setStartDate(range.from);
                    if (range?.to) setEndDate(range.to);
                  }}
                  disabled={{
                    after: new Date()
                  }}
                  className="mx-auto"
                />
              </div>
              
              <div className="mt-4 flex justify-end">
                <Button 
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                  onClick={handleApplyCustomDates}
                  disabled={!startDate || !endDate}
                >
                  Apply Custom Range
                </Button>
              </div>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}