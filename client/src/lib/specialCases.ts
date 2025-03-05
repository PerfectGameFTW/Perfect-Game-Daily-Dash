/**
 * SPECIAL CASES MODULE - REMOVED
 * 
 * This module has been completely removed as part of the UTC-based system architecture.
 * We now use a single unified approach with UTC-based timestamps throughout the system:
 * 
 * 1. All timestamps are stored in the database as UTC
 * 2. All database queries use direct UTC timestamp comparisons
 * 3. The frontend handles display-only timezone conversion for user interface
 * 
 * This ensures consistent data reporting across all time periods with no special cases.
 */

import { DateRange } from "@shared/schema";

// Stub functions to maintain API compatibility
export function isFeb25Case(dateRange: DateRange): boolean {
  return false; // No special cases needed with UTC-based architecture
}

export function getGiftCardAmount(dateRange: DateRange, defaultAmount: number = 0): number {
  return defaultAmount; // Always use values directly from the database
}