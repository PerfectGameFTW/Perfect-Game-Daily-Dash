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
  console.log('Navigate Date:', { 
    direction, 
    currentDateRange, 
    customStartDate: customStartDate?.toISOString(), 
    customEndDate: customEndDate?.toISOString() 
  });
  
  const today = new Date();
  // Set to midnight in local timezone for consistent date comparisons
  today.setHours(0, 0, 0, 0);
  
  // Normalize input dates to midnight for consistent comparison
  let normalizedStartDate: Date | undefined;
  let normalizedEndDate: Date | undefined;
  
  if (customStartDate) {
    normalizedStartDate = new Date(customStartDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
  }
  
  if (customEndDate) {
    normalizedEndDate = new Date(customEndDate);
    normalizedEndDate.setHours(0, 0, 0, 0);
  }
  
  // Check if we're looking at current data or historical
  const isCurrentView = (currentDateRange === 'today' && !customStartDate) || 
                        (currentDateRange === 'yesterday' && !customStartDate) ||
                        (currentDateRange === 'last7days' && !customStartDate) ||
                        (currentDateRange === 'last30days' && !customStartDate) ||
                        (currentDateRange === 'thisMonth' && !customStartDate) ||
                        (currentDateRange === 'lastMonth' && !customStartDate);
  
  // Determine how to navigate based on the current date range
  switch (currentDateRange) {
    case 'today':
      // For today's view, navigate by single days
      if (normalizedStartDate) {
        // If we're already viewing a specific day
        if (direction === 'prev') {
          const prevDate = subDays(normalizedStartDate, 1);
          // For consistency, use "yesterday" range when going back one day from today
          // This ensures data is looked up the same way regardless of navigation method
          if (isSameDay(normalizedStartDate, today)) {
            return { dateRange: 'yesterday', startDate: undefined, endDate: undefined };
          }
          return { dateRange: 'custom', startDate: prevDate, endDate: prevDate };
        } else {
          // Don't navigate past today
          if (isSameDay(normalizedStartDate, today)) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          
          const nextDate = addDays(normalizedStartDate, 1);
          // Don't go beyond today
          if (nextDate > today) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          
          // If we're navigating to today, use the standard today range
          if (isSameDay(nextDate, today)) {
            return { dateRange: 'today', startDate: undefined, endDate: undefined };
          }
          
          return { dateRange: 'custom', startDate: nextDate, endDate: nextDate };
        }
      } else {
        // If we're viewing actual today, can only go backward
        if (direction === 'prev') {
          // Use the predefined "yesterday" range
          return { dateRange: 'yesterday', startDate: undefined, endDate: undefined };
        }
        // Can't navigate past today
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }
      
    case 'yesterday':
      // For yesterday's view, navigate by single days
      if (direction === 'prev') {
        const twoDaysAgo = subDays(today, 2);
        return { dateRange: 'custom', startDate: twoDaysAgo, endDate: twoDaysAgo };
      } else {
        // Going forward from yesterday takes us to today
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }
      
    case 'last7days':
      // For 7-day view, navigate by weeks
      if (normalizedStartDate && normalizedEndDate) {
        // If we're viewing a custom 7-day range
        const rangeDays = Math.round((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (direction === 'prev') {
          const newStartDate = subDays(normalizedStartDate, rangeDays + 1);
          const newEndDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        } else {
          const newStartDate = addDays(normalizedEndDate, 1);
          // If moving forward would take us to current view
          if (isSameDay(addDays(newStartDate, rangeDays), today) || addDays(newStartDate, rangeDays) > today) {
            return { dateRange: 'last7days', startDate: undefined, endDate: undefined };
          } else {
            const newEndDate = addDays(normalizedEndDate, rangeDays + 1);
            return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
          }
        }
      } else if (direction === 'prev') {
        // Standard 7-day range navigation
        const prevWeekStart = subDays(today, 13); // 7 + 6 days ago
        const prevWeekEnd = subDays(today, 7); // 7 days ago
        return { dateRange: 'custom', startDate: prevWeekStart, endDate: prevWeekEnd };
      } else {
        // Going forward takes us to current 7 days
        return { dateRange: 'last7days', startDate: undefined, endDate: undefined };
      }
      
    case 'last30days':
      // For 30-day view, navigate by months
      if (normalizedStartDate && normalizedEndDate) {
        // If we're viewing a custom 30-day range
        const rangeDays = Math.round((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (direction === 'prev') {
          const newStartDate = subDays(normalizedStartDate, rangeDays + 1);
          const newEndDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        } else {
          const newStartDate = addDays(normalizedEndDate, 1);
          // If moving forward would take us to current view
          if (isSameDay(addDays(newStartDate, rangeDays), today) || addDays(newStartDate, rangeDays) > today) {
            return { dateRange: 'last30days', startDate: undefined, endDate: undefined };
          } else {
            const newEndDate = addDays(normalizedEndDate, rangeDays + 1);
            return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
          }
        }
      } else if (direction === 'prev') {
        // Standard 30-day range navigation
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
      if (normalizedStartDate && normalizedEndDate) {
        // Calculate the range size in days
        const rangeDays = Math.round((normalizedEndDate.getTime() - normalizedStartDate.getTime()) / (1000 * 60 * 60 * 24));
        console.log(`Custom range is ${rangeDays} days from ${normalizedStartDate.toISOString()} to ${normalizedEndDate.toISOString()}`);
        
        if (direction === 'prev') {
          // Move backward by the same range size
          const newStartDate = subDays(normalizedStartDate, rangeDays + 1);
          const newEndDate = subDays(normalizedStartDate, 1);
          return { dateRange: 'custom', startDate: newStartDate, endDate: newEndDate };
        } else {
          // Move forward by the same range size
          const newStartDate = addDays(normalizedEndDate, 1);
          const newEndDate = addDays(normalizedEndDate, rangeDays + 1);
          
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
        console.warn('Custom date range with missing date values, defaulting to today');
        return { dateRange: 'today', startDate: undefined, endDate: undefined };
      }
      
    default:
      console.warn(`Unhandled date range: ${currentDateRange}, defaulting to today`);
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
