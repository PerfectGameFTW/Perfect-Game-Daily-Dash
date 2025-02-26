import { DateRange } from "@shared/schema";
import { format, subDays, addDays, startOfMonth, endOfMonth, isToday, subMonths, addMonths, subWeeks, addWeeks, isSameDay } from "date-fns";

export function getFormattedDate(dateRange: DateRange, customStartDate?: Date, customEndDate?: Date): string {
  const now = new Date();

  switch (dateRange) {
    case "today":
      return format(now, "MMMM d, yyyy");
    case "yesterday":
      return format(subDays(now, 1), "MMMM d, yyyy");
    case "last7days":
      return `${format(subDays(now, 6), "MMM d")} - ${format(now, "MMM d, yyyy")}`;
    case "last30days":
      return `${format(subDays(now, 29), "MMM d")} - ${format(now, "MMM d, yyyy")}`;
    case "thisMonth":
      return format(now, "MMMM yyyy");
    case "lastMonth": {
      const lastMonth = subDays(startOfMonth(now), 1);
      return format(lastMonth, "MMMM yyyy");
    }
    case "custom":
      if (!customStartDate || !customEndDate) {
        return format(now, "MMMM d, yyyy");
      }
      if (format(customStartDate, "yyyy-MM-dd") === format(customEndDate, "yyyy-MM-dd")) {
        return format(customStartDate, "MMMM d, yyyy");
      }
      return `${format(customStartDate, "MMM d")} - ${format(customEndDate, "MMM d, yyyy")}`;
    default:
      return format(now, "MMMM d, yyyy");
  }
}

export function navigateDate(
  direction: 'prev' | 'next',
  currentDateRange: DateRange,
  customStartDate?: Date,
  customEndDate?: Date
): { 
  dateRange: DateRange, 
  startDate?: Date, 
  endDate?: Date 
} {
  // Log inputs for debugging
  console.log('Navigate Date:', { direction, currentDateRange, customStartDate, customEndDate });
  
  const today = new Date();
  
  // Reset hours, minutes, seconds, and milliseconds for consistent date comparisons
  today.setHours(0, 0, 0, 0);

  switch (currentDateRange) {
    case "today": {
      if (direction === 'prev') {
        return { dateRange: "today", startDate: subDays(today, 1), endDate: subDays(today, 1) };
      } else {
        // If today is actually today, we can't go forward
        const tomorrow = addDays(today, 1);
        const nowDate = new Date();
        nowDate.setHours(0, 0, 0, 0);
        
        if (isSameDay(tomorrow, nowDate) || tomorrow > nowDate) {
          return { dateRange: "today", startDate: undefined, endDate: undefined };
        }
        return { dateRange: "today", startDate: tomorrow, endDate: tomorrow };
      }
    }
    
    case "yesterday": {
      if (direction === 'prev') {
        return { dateRange: "yesterday", startDate: subDays(today, 2), endDate: subDays(today, 2) };
      } else {
        return { dateRange: "today" };
      }
    }
    
    case "last7days": {
      if (direction === 'prev') {
        return { 
          dateRange: "custom", 
          startDate: subWeeks(customStartDate || subDays(today, 6), 1), 
          endDate: subWeeks(customEndDate || today, 1)
        };
      } else {
        const newEndDate = addWeeks(customEndDate || today, 1);
        // Don't go beyond current date
        if (newEndDate > today) {
          return { dateRange: "last7days" };
        }
        return { 
          dateRange: "custom", 
          startDate: addWeeks(customStartDate || subDays(today, 6), 1), 
          endDate: newEndDate
        };
      }
    }
    
    case "thisMonth": {
      if (direction === 'prev') {
        const prevMonth = subMonths(today, 1);
        return { 
          dateRange: "custom", 
          startDate: startOfMonth(prevMonth), 
          endDate: endOfMonth(prevMonth)
        };
      } else {
        const nextMonth = addMonths(today, 1);
        // Don't go beyond current month
        if (nextMonth.getMonth() === today.getMonth() || nextMonth > today) {
          return { dateRange: "thisMonth" };
        }
        return { 
          dateRange: "custom", 
          startDate: startOfMonth(nextMonth), 
          endDate: endOfMonth(nextMonth)
        };
      }
    }
    
    case "last30days": {
      if (direction === 'prev') {
        return { 
          dateRange: "custom", 
          startDate: subDays(customStartDate || subDays(today, 29), 30), 
          endDate: subDays(customEndDate || today, 30)
        };
      } else {
        const newEndDate = addDays(customEndDate || today, 30);
        // Don't go beyond current date
        if (newEndDate > today) {
          return { dateRange: "last30days" };
        }
        return { 
          dateRange: "custom", 
          startDate: addDays(customStartDate || subDays(today, 29), 30), 
          endDate: newEndDate
        };
      }
    }
    
    case "lastMonth": {
      if (direction === 'prev') {
        const prevMonth = subMonths(today, 2);
        return { 
          dateRange: "custom", 
          startDate: startOfMonth(prevMonth), 
          endDate: endOfMonth(prevMonth)
        };
      } else {
        return { dateRange: "thisMonth" };
      }
    }
    
    case "custom": {
      if (!customStartDate || !customEndDate) {
        return { dateRange: "today" };
      }
      
      // Calculate the duration between start and end dates
      const diffInDays = Math.round((customEndDate.getTime() - customStartDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (direction === 'prev') {
        return { 
          dateRange: "custom", 
          startDate: subDays(customStartDate, diffInDays + 1), 
          endDate: subDays(customEndDate, diffInDays + 1)
        };
      } else {
        const newEndDate = addDays(customEndDate, diffInDays + 1);
        // Don't go beyond current date
        if (newEndDate > today) {
          return { 
            dateRange: "custom", 
            startDate: customStartDate, 
            endDate: customEndDate
          };
        }
        return { 
          dateRange: "custom", 
          startDate: addDays(customStartDate, diffInDays + 1), 
          endDate: newEndDate
        };
      }
    }
    
    default:
      return { dateRange: currentDateRange };
  }
}

export function isPositiveChange(value: number): boolean {
  return value >= 0;
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function formatPercentage(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(value / 100);
}
