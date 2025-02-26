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
import { ChevronRight } from "lucide-react";
import { format } from "date-fns";

interface TimeframeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange, start?: Date, end?: Date) => void;
}

export default function TimeframeModal({
  open,
  onOpenChange,
  dateRange,
  onDateRangeChange
}: TimeframeModalProps) {
  const [selectedRange, setSelectedRange] = useState<DateRange>(dateRange);
  
  // Update selected range when dateRange prop changes
  useEffect(() => {
    setSelectedRange(dateRange);
  }, [dateRange]);

  const handleSelectRange = (newRange: DateRange) => {
    setSelectedRange(newRange);
    onDateRangeChange(newRange);
    onOpenChange(false);
  };

  const timeframes: { label: string, value: DateRange }[] = [
    { label: "Today", value: "today" },
    { label: "This week", value: "last7days" },
    { label: "This month", value: "thisMonth" },
    { label: "This year", value: "last30days" },
    { label: "Custom date", value: "custom" },
  ];

  // Format reporting hours (just for display)
  const reportingHours = "All day · 12:00 AM — 11:59 PM EST";

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
        </div>
      </DrawerContent>
    </Drawer>
  );
}