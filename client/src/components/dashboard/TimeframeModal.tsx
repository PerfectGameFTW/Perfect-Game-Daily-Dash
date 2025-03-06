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
import { ChevronRight, Calendar, ArrowLeft, CheckCircle } from "lucide-react";
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
      <DrawerContent className="bg-gradient-to-b from-gray-900 to-black border-t border-white/10 rounded-t-xl overflow-y-auto backdrop-blur-sm" aria-describedby="timeframe-description">
        <DrawerHeader>
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
            <DrawerTitle className="text-xl font-semibold text-white">Select Timeframe</DrawerTitle>
            <DrawerClose asChild>
              <Button variant="outline" className="bg-black/30 border-white/20 text-white hover:bg-white/10 px-4 py-1 h-auto">
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
              <div className="space-y-2 mt-2">
                {timeframes.map((timeframe) => (
                  <div 
                    key={timeframe.value}
                    className={`p-3 rounded-lg flex items-center justify-between cursor-pointer transition-all ${
                      selectedRange === timeframe.value 
                        ? "bg-primary text-white shadow-lg shadow-primary/20" 
                        : "bg-white/5 hover:bg-white/10 text-white border border-white/5"
                    }`}
                    onClick={() => handleSelectRange(timeframe.value)}
                  >
                    <span className="font-medium">{timeframe.label}</span>
                    {selectedRange === timeframe.value && (
                      <CheckCircle className="h-5 w-5" />
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-6 border border-white/10 rounded-xl bg-black/30 overflow-hidden transition-all hover:border-primary/30">
                <div className="p-4 flex items-center justify-between cursor-pointer">
                  <div className="flex items-center">
                    <div className="h-10 w-10 rounded-lg bg-red-600/10 flex items-center justify-center mr-3">
                      <Calendar className="h-5 w-5 text-red-600" />
                    </div>
                    <span className="font-medium text-white">Reporting hours</span>
                  </div>
                  <div className="flex items-center">
                    <span className="text-sm text-white/60 mr-2">
                      {reportingHours}
                    </span>
                    <ChevronRight className="h-4 w-4 text-white/40" />
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
                className="mb-6 text-white/70 hover:text-white flex items-center gap-2"
                onClick={() => setCalendarOpen(false)}
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back to timeframes</span>
              </Button>
              
              <div className="mb-6">
                <h3 className="text-lg font-bold text-white mb-2">Custom date range</h3>
                <p className="text-white/60 text-sm mb-3">
                  {!endDate ? "Select start and end dates for your data view" : ""}
                </p>
                <div className="bg-white/5 p-4 rounded-xl border border-white/10 shadow-lg">
                  <div className="flex items-center gap-2">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Calendar className="h-5 w-5 text-primary" />
                    </div>
                    <span className="text-white font-medium">{getDateRangePreview()}</span>
                  </div>
                </div>
              </div>
              
              <div className="bg-black/40 p-6 rounded-xl border border-white/10 shadow-lg">
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
              
              <div className="mt-6 flex justify-end">
                <Button 
                  className="bg-primary hover:bg-primary/90 text-white font-medium py-2 px-6 shadow-lg shadow-primary/30"
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