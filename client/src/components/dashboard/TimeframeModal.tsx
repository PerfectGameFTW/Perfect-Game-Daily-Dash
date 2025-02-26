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
      <DrawerContent className="bg-black border-t border-zinc-800 rounded-t-xl">
        <div className="mx-auto mt-4 h-1.5 w-16 rounded-full bg-zinc-700" />
        <DrawerHeader className="pt-4 px-6 pb-3">
          <DrawerTitle className="text-2xl font-semibold text-white">Timeframe</DrawerTitle>
        </DrawerHeader>
        <div className="px-6 pb-10">
          {timeframes.map((timeframe) => (
            <div 
              key={timeframe.value}
              className="py-4 border-b border-zinc-800 flex items-center justify-between cursor-pointer"
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

          <div className="mt-6 border border-zinc-800 rounded-lg bg-zinc-900">
            <div className="p-4 flex items-center justify-between">
              <span className="font-medium text-white">Reporting hours</span>
              <div className="flex items-center">
                <span className="text-sm text-zinc-400 mr-2">
                  {reportingHours}
                </span>
                <ChevronRight className="h-4 w-4 text-zinc-400" />
              </div>
            </div>
          </div>

          <DrawerClose asChild>
            <Button 
              className="w-full mt-4 justify-center bg-blue-500 hover:bg-blue-600 text-white"
            >
              Done
            </Button>
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}