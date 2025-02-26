import { DateRange } from "@shared/schema";
import { format, subDays, startOfMonth, endOfMonth, isToday } from "date-fns";

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
