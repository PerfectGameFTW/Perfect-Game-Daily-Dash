/**
 * Special cases module for handling known data inconsistencies
 * This allows us to apply client-side fixes for data that cannot be fixed on the backend
 */

import { DateRange, GiftCardSummary } from "@shared/schema";

/**
 * Checks if we're looking at Feb 25, 2025 data - DISABLED
 * This function always returns false now as we're using direct API data
 */
export function isFeb25Case(dateRange: DateRange): boolean {
  return false; // We're no longer using hardcoded data for Feb 25
}

/**
 * Special gift card data for Feb 25, 2025 - DISABLED
 * We're no longer using hardcoded data, this is kept for reference
 */
export const FEB_25_GIFT_CARD_DATA: GiftCardSummary = {
  soldCount: 0,
  soldAmount: 0, 
  redeemedCount: 0,
  redeemedAmount: 0,
  averageValue: 0
};

/**
 * Get the correct gift card amount for a given date range
 * This function no longer uses hardcoded values and just returns the API data
 */
export function getGiftCardAmount(dateRange: DateRange, defaultAmount: number = 0): number {
  return defaultAmount; // Always use the value from the API
}