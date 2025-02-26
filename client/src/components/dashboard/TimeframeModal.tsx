import { useState } from "react";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle 
} from "@/components/ui/dialog";
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-md p-0 bg-background rounded-lg">
        <DialogHeader className="pt-6 px-6 pb-3">
          <DialogTitle className="text-2xl font-semibold">Timeframe</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6">
          {timeframes.map((timeframe) => (
            <div 
              key={timeframe.value}
              className="py-4 border-b border-border flex items-center justify-between"
              onClick={() => handleSelectRange(timeframe.value)}
            >
              <span>{timeframe.label}</span>
              {selectedRange === timeframe.value && (
                <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                  <div className="w-2 h-2 rounded-full bg-white"></div>
                </div>
              )}
            </div>
          ))}

          <div className="mt-6 border border-border rounded-lg">
            <div className="p-4 flex items-center justify-between">
              <span className="font-medium">Reporting hours</span>
              <div className="flex items-center">
                <span className="text-sm text-muted-foreground mr-2">
                  {reportingHours}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
          </div>

          <Button 
            className="w-full mt-4 justify-center"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}