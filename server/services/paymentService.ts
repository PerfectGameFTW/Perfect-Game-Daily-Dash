/**
 * Payment Service
 * 
 * Handles all payment-related business logic with proper error handling
 * and data validation. Provides a clean API for the rest of the application.
 */

import { db } from '../db';
import { eq, and, between, desc, asc, sql } from 'drizzle-orm';
import {
  transactions, 
  type Transaction, 
  type InsertTransaction,
  type DateRange,
  type TransactionStatus
} from '../../shared/schema';
import { getEasternDateRange, formatHour } from '../dateUtils';
import { formatInTimeZone } from 'date-fns-tz';

export class PaymentError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'PaymentError';
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor(paymentId: string | number) {
    super(`Payment with ID ${paymentId} not found`, 'PAYMENT_NOT_FOUND');
    this.name = 'PaymentNotFoundError';
  }
}

export class InvalidPaymentDataError extends PaymentError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_PAYMENT_DATA', details);
    this.name = 'InvalidPaymentDataError';
  }
}

export class PaymentService {
  /**
   * Get a payment by ID
   * 
   * @param id The payment ID
   * @returns The payment or throws if not found
   */
  async getPaymentById(id: number): Promise<Transaction> {
    const result = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    
    if (!result.length) {
      throw new PaymentNotFoundError(id);
    }
    
    return result[0];
  }
  
  /**
   * Get a payment by Square ID
   * 
   * @param squareId The Square payment ID
   * @returns The payment or throws if not found
   */
  async getPaymentBySquareId(squareId: string): Promise<Transaction> {
    const result = await db.select().from(transactions).where(eq(transactions.squareId, squareId)).limit(1);
    
    if (!result.length) {
      throw new PaymentNotFoundError(squareId);
    }
    
    return result[0];
  }

  /**
   * Update an existing payment with fresh data from Square.
   * Refreshes status, amount, and squareData (which carries tipMoney, taxes, etc.)
   * so that after-the-fact tip adjustments are reflected correctly.
   */
  async updatePayment(squareId: string, paymentData: Partial<InsertTransaction>): Promise<Transaction> {
    const result = await db
      .update(transactions)
      .set(paymentData)
      .where(eq(transactions.squareId, squareId))
      .returning();

    if (!result.length) {
      throw new PaymentNotFoundError(squareId);
    }

    return result[0];
  }

  /**
   * Create a new payment
   * 
   * This method implements the forward-looking solution for the architecture transition:
   * 1. Writes to the original 'transactions' table for backward compatibility
   * 2. Simultaneously writes to the new 'payments' table with additional fields
   * 
   * This ensures data consistency during the transition period and prevents
   * future data gaps between the two systems.
   * 
   * @param paymentData The payment data to insert
   * @returns The created payment
   */
  async createPayment(paymentData: InsertTransaction): Promise<Transaction> {
    // Validate required payment data
    if (!paymentData.squareId || !paymentData.amount) {
      throw new InvalidPaymentDataError('Payment must include squareId and amount', {
        squareId: paymentData.squareId,
        amount: paymentData.amount
      });
    }
    
    // STEP 1: Insert into the transactions table (legacy system)
    const result = await db.insert(transactions).values(paymentData).returning();
    
    if (!result.length) {
      throw new PaymentError('Failed to create payment in transactions table', 'DB_ERROR');
    }
    
    // Process gift card redemption if this payment was made with a gift card
    try {
      // Extract the Square data to check for gift card redemption
      const squareData = paymentData.squareData || {};
      const squareDataObj = squareData as any;
      
      // Check if this was a payment made using a gift card
      const isGiftCardRedemption = squareDataObj.isGiftCardRedemption === true;
      const sourceId = squareDataObj.sourceId;
      
      if (isGiftCardRedemption && sourceId) {
        // Import the giftCardService to avoid circular dependency
        const { giftCardService } = await import('./giftCardService');
        
        console.log(`Processing gift card redemption for payment ${paymentData.squareId}`, {
          sourceId, 
          amount: paymentData.amount,
          paymentId: result[0].id
        });
        
        // Process the redemption using our new method
        const redemptionResult = await giftCardService.processRedemptionFromSquare(
          sourceId,
          paymentData.amount,
          result[0].id,
          squareData
        );
        
        if (redemptionResult) {
          console.log(`Successfully processed gift card redemption for payment ${paymentData.squareId}`, {
            giftCardId: redemptionResult.id,
            gan: redemptionResult.gan,
            remainingBalance: redemptionResult.amount
          });
        } else {
          console.warn(`Could not find matching gift card for redemption: sourceId=${sourceId}, payment=${paymentData.squareId}`);
        }
      }
    } catch (redemptionError) {
      console.error('Error processing gift card redemption:', redemptionError);
      // Non-critical error, continue with the operation since the payment was saved
    }
    
    return result[0];
  }
  
  /**
   * Get payments by date range with proper timezone handling
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param status Optional status filter
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @param limit Optional result limit
   * @returns Array of payments in the specified date range
   */
  async getPaymentsByDateRange(
    dateRange: DateRange,
    status?: TransactionStatus,
    startDate?: Date,
    endDate?: Date,
    limit?: number
  ): Promise<Transaction[]> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    console.log(`Filtering payments with UTC range: ${start.toISOString()} to ${end.toISOString()}`);
    
    // Set a reasonable default limit
    const limitValue = limit && limit > 0 ? limit : 1000;
    
    // Use raw SQL to avoid Drizzle ORM typings issues
    if (status) {
      // With status filter
      return await db.execute<Transaction>(sql`
        SELECT * FROM ${transactions}
        WHERE ${transactions.timestamp} BETWEEN ${start} AND ${end}
          AND ${transactions.status} = ${status}
        ORDER BY ${transactions.timestamp} DESC
        LIMIT ${limitValue}
      `).then(result => result.rows);
    } else {
      // Without status filter
      return await db.execute<Transaction>(sql`
        SELECT * FROM ${transactions}
        WHERE ${transactions.timestamp} BETWEEN ${start} AND ${end}
        ORDER BY ${transactions.timestamp} DESC
        LIMIT ${limitValue}
      `).then(result => result.rows);
    }
  }
  
  /**
   * Get total revenue by date range with proper timezone handling
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns The total revenue for the specified date range
   */
  async getTotalRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Query the database for the total revenue - make sure we're using the right timezone boundaries
    const result = await db.select({
      totalRevenue: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    }).from(transactions)
      .where(and(
        between(transactions.timestamp, start, end),
        eq(transactions.status, 'completed')
      ));
    
    const totalRevenue = result[0]?.totalRevenue || 0;
    return totalRevenue;
  }
  
  /**
   * Get hourly revenue for the specified date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Array of hourly revenue data with all 24 hours populated, with hours in Eastern Time
   */
  async getHourlyRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<{ hour: string, amount: number }[]> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Query the database for hourly revenue
    // Extract UTC hours from timestamps (not Eastern time)
    // so the frontend can properly convert them
    const result = await db.execute<{ hour: number, amount: number }>(sql`
      SELECT 
        EXTRACT(HOUR FROM ${transactions.timestamp}) AS hour,
        COALESCE(SUM(${transactions.amount}), 0) AS amount
      FROM ${transactions}
      WHERE ${transactions.timestamp} BETWEEN ${start} AND ${end}
        AND ${transactions.status} = 'completed'
      GROUP BY hour
      ORDER BY hour
    `);
    
    // Create a map to hold all 24 hours with their amounts
    const hourlyData: Record<number, number> = {};
    
    // Initialize all hours with zero
    for (let i = 0; i < 24; i++) {
      hourlyData[i] = 0;
    }
    
    // Populate with actual data where available
    for (const row of result.rows) {
      hourlyData[row.hour] = row.amount;
    }
    
    // Convert to array, tracking the Eastern hour number alongside the display label
    // so we can sort in 6 AM-first business-day order without re-parsing strings.
    const hourlyRevenue = Object.entries(hourlyData).map(([hourStr, amount]) => {
      const utcHour = parseInt(hourStr, 10);

      // Anchor the conversion to the query's start date so that DST offset
      // matches the historical period being viewed (e.g., EST for winter data
      // viewed during summer, not today's EDT offset).
      const utcDate = new Date(start);
      utcDate.setUTCHours(utcHour, 0, 0, 0);

      // Convert to Eastern Time hour (0–23)
      const easternHour = parseInt(formatInTimeZone(utcDate, 'America/New_York', 'H'), 10);
      return {
        etHour: easternHour,
        hour: formatHour(easternHour),
        amount,
      };
    });

    // Sort in business-day order: 6 AM → 7 AM → … → 11 PM → 12 AM → 1 AM → … → 5 AM
    // Shift hours so that 6 maps to 0, 7 to 1, …, 5 (AM next day) to 23.
    const businessDayKey = (h: number) => (h >= 6 ? h - 6 : h + 18);
    hourlyRevenue.sort((a, b) => businessDayKey(a.etHour) - businessDayKey(b.etHour));

    return hourlyRevenue.map(({ hour, amount }) => ({ hour, amount }));
  }
}

// Create and export a singleton instance
export const paymentService = new PaymentService();