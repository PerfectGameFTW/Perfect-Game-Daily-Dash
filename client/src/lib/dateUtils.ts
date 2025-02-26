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
  today.setHours(0, 0, 0, 0); // Reset time components for consistent comparisons
  
  // Determine how to navigate based on the current date range
  switch (currentDateRange) {
    case 'today':
      // For today's view, navigate by single days
      if (customStartDate) {
        // If we're already viewing a specific day
        if (direction === 'prev') {
          const prevDate = subDays(customStartDate, 1);
          return { dateRange: 'today', startDate: prevDate, endDate: prevDate };
        } else {
          // Don't navigate past today
          if (isSameDay(customStartDate, today)) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          
          const nextDate = addDays(customStartDate, 1);
          // Don't go beyond today
          if (nextDate > today) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          
          return { dateRange: 'today', startDate: nextDate, endDate: nextDate };
        }
      } else {
        // If we're viewing actual today, can only go backward
        if (direction === 'prev') {
          const yesterday = subDays(today, 1);
          return { dateRange: 'today', startDate: yesterday, endDate: yesterday };
        }
        // Can't navigate past today
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }
      
    case 'yesterday':
      // For yesterday's view, navigate by single days
      if (direction === 'prev') {
        const twoDaysAgo = subDays(today, 2);
        return { dateRange: 'today', startDate: twoDaysAgo, endDate: twoDaysAgo };
      } else {
        // Going forward from yesterday takes us to today
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }
      
    case 'last7days':
      // For 7-day view, navigate by weeks
      if (direction === 'prev') {
        const prevWeekStart = subDays(today, 13); // 7 + 6 days ago
        const prevWeekEnd = subDays(today, 7); // 7 days ago
        return { dateRange: 'custom', startDate: prevWeekStart, endDate: prevWeekEnd };
      } else {
        // Going forward takes us to current 7 days
        return { dateRange: 'last7days', startDate: undefined, endDate: undefined };
      }
      
    case 'last30days':
      // For 30-day view, navigate by months
      if (direction === 'prev') {
        const prevMonthStart = subDays(today, 59); // 30 + 29 days ago
        const prevMonthEnd = subDays(today, 30); // 30 days ago
        return { dateRange: 'custom', startDate: prevMonthStart, endDate: prevMonthEnd };
      } else {
        // Going forward takes us to current 30 days
        return { dateRange: 'last30days', startDate: undefined, endDate: undefined };
      }
      
    case 'thisMonth':
      // For this month view, navigate by months
      if (direction === 'prev') {
        const lastMonthStart = startOfMonth(subMonths(today, 1));
        const lastMonthEnd = endOfMonth(subMonths(today, 1));
        return { dateRange: 'custom', startDate: lastMonthStart, endDate: lastMonthEnd };
      } else {
        // Going forward from this month doesn't make sense
        return { dateRange: 'thisMonth', startDate: undefined, endDate: undefined };
      }
      
    case 'lastMonth':
      // For last month view, navigate by months
      if (direction === 'prev') {
        const twoMonthsAgoStart = startOfMonth(subMonths(today, 2));
        const twoMonthsAgoEnd = endOfMonth(subMonths(today, 2));
        return { dateRange: 'custom', startDate: twoMonthsAgoStart, endDate: twoMonthsAgoEnd };
      } else {
        // Going forward takes us to this month
        return { dateRange: 'thisMonth', startDate: undefined, endDate: undefined };
      }
      
    case 'custom':
      // For custom date range, navigate based on the difference between start and end dates
      if (customStartDate && customEndDate) {
        // Calculate the range size in days
        const rangeDays = Math.round((customEndDate.getTime() - customStartDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (direction === 'prev') {
          const newStartDate = subDays(customStartDate, rangeDays + 1);
          const newEndDate = subDays(customStartDate, 1);
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        } else {
          const newStartDate = addDays(customEndDate, 1);
          const newEndDate = addDays(customEndDate, rangeDays + 1);
          
          // Don't go beyond today
          if (newEndDate > today) {
            // If the window would extend past today, adjust to end at today
            if (newStartDate < today) {
              return { dateRange: 'custom', startDate: newStartDate, endDate: today };
            } else {
              // If even the start date is beyond today, return to today's view
              return { dateRange: 'today', startDate: undefined, endDate: undefined };
            }
          }
          
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        }
      } else {
        // If missing dates, default to today
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }
      
    default:
      return { dateRange: 'today', startDate: undefined, endDate: undefined };
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
