/**
 * SPECIAL CASES MODULE - DEPRECATED
 * 
 * This module has been completely deprecated as part of the sync simplification process.
 * We now use a single, unified sync process with no special case handling.
 * All data comes directly from the database with consistent processing.
 * 
 * These stub functions are maintained for backward compatibility only
 * and will be removed in a future update.
 */

import { DateRange } from "@shared/schema";

// Stub functions to maintain API compatibility
export function isFeb25Case(dateRange: DateRange): boolean {
  return false; // Special cases have been removed completely
}

export function getGiftCardAmount(dateRange: DateRange, defaultAmount: number = 0): number {
  return defaultAmount; // Always use the value from the database
}