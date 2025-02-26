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

  // Simplify navigation - ignore the named ranges and just treat all as custom date navigation
  // This makes arrow navigation more intuitive
  
  // First, determine the reference date to work with
  let referenceDate: Date;
  
  if (customStartDate) {
    // If a custom date is set, use it as reference
    referenceDate = new Date(customStartDate);
  } else {
    // If no custom date, use today for reference
    referenceDate = new Date(today);
  }
  
  // Now navigate forward or backward from the reference date
  if (direction === 'prev') {
    const prevDate = subDays(referenceDate, 1);
    return { 
      dateRange: "today", 
      startDate: prevDate, 
      endDate: prevDate 
    };
  } else { // direction === 'next'
    // Don't navigate past today
    if (isSameDay(referenceDate, today)) {
      return { 
        dateRange: "today", 
        startDate: undefined, 
        endDate: undefined 
      };
    }
    
    const nextDate = addDays(referenceDate, 1);
    
    // Don't go beyond today
    if (nextDate > today) {
      return { 
        dateRange: "today", 
        startDate: undefined, 
        endDate: undefined 
      };
    }
    
    return { 
      dateRange: "today", 
      startDate: nextDate, 
      endDate: nextDate 
    };
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
