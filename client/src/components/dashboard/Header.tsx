import { Menu, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import DateRangePicker from "./DateRangePicker";
import { DateRange } from "@shared/schema";
import { getFormattedDate } from "@/lib/dateUtils";

interface HeaderProps {
  openSidebar: () => void;
  dateRange: DateRange;
  customStartDate?: Date;
  customEndDate?: Date;
  onDateRangeChange: (range: DateRange, start?: Date, end?: Date) => void;
}

export default function Header({ 
  openSidebar, 
  dateRange, 
  customStartDate, 
  customEndDate, 
  onDateRangeChange 
}: HeaderProps) {
  const formattedDate = getFormattedDate(dateRange, customStartDate, customEndDate);

  return (
    <div className="relative z-10 flex-shrink-0 flex h-16 bg-white shadow">
      <Button
        variant="ghost"
        size="icon"
        onClick={openSidebar}
        className="md:hidden px-4 text-gray-500 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary"
      >
        <span className="sr-only">Open sidebar</span>
        <Menu className="h-6 w-6" />
      </Button>
      
      <div className="flex-1 px-4 flex justify-between">
        <div className="flex-1 flex items-center">
          <DateRangePicker 
            value={dateRange}
            onValueChange={onDateRangeChange}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
          />
          <span className="ml-2 text-sm text-gray-700">{formattedDate}</span>
        </div>
        
        <div className="ml-4 flex items-center md:ml-6">
          <Button variant="ghost" size="icon" className="p-1 rounded-full text-gray-400 hover:text-gray-500 focus:outline-none">
            <span className="sr-only">View notifications</span>
            <Bell className="h-6 w-6" />
          </Button>

          {/* Profile dropdown */}
          <div className="ml-3 relative">
            <div>
              <Button
                variant="ghost"
                className="max-w-xs bg-white flex items-center text-sm rounded-full focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
              >
                <span className="sr-only">Open user menu</span>
                <Avatar className="h-8 w-8">
                  <AvatarImage src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&ixlib=rb-1.2.1&auto=format&fit=crop&w=100&q=80" alt="User avatar" />
                  <AvatarFallback>US</AvatarFallback>
                </Avatar>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
