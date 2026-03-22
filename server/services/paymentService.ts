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
   * Create a new payment with dual-table write functionality
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
    
    // STEP 2: Insert into the payments table (new system)
    try {
      // Extract data from Square transaction
      const squareData = paymentData.squareData || {};
      const squareDataObject = squareData as any;
      
      // Use a direct SQL approach to insert into payments table
      // This is similar to our reconciliation function which we know works
      const paymentInsertResult = await db.execute(sql`
        WITH inserted_payment AS (
          INSERT INTO payments 
            (square_id, status, amount, tip_amount, tax_amount, timestamp, currency, is_gift_card_activation, metadata)
          SELECT 
            ${paymentData.squareId},
            ${paymentData.status},
            ${paymentData.amount},
            0,
            0,
            ${paymentData.timestamp},
            'USD',
            ${paymentData.categoryId === 'giftCard'},
            ${JSON.stringify(squareData)}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM payments WHERE square_id = ${paymentData.squareId}
          )
          RETURNING id
        )
        SELECT COUNT(*) AS inserted FROM inserted_payment
      `);
      
      // Check if we successfully inserted a new payment
      const inserted = parseInt(paymentInsertResult.rows?.[0]?.inserted?.toString() || '0', 10) > 0;
      
      if (inserted) {
        console.log(`Successfully wrote NEW payment ${paymentData.squareId} to both transactions and payments tables`);
      } else {
        console.log(`Payment ${paymentData.squareId} already exists in payments table, skipped insertion`);
      }
      
      // Record the dual-write in the sync state table for audit
      try {
        await db.execute(sql`
          INSERT INTO sync_state (
            sync_type, last_synced_at, processed_count, status, last_checkpoint
          ) VALUES (
            'payment_dual_write', 
            CURRENT_TIMESTAMP, 
            1, 
            'completed',
            ${JSON.stringify({
              squareId: paymentData.squareId,
              timestamp: new Date().toISOString(),
              alreadyExisted: !inserted
            })}::jsonb
          )
        `);
      } catch (syncError) {
        // Non-critical error, just log it
        console.warn('Failed to record successful dual-write:', syncError);
      }
      
    } catch (error) {
      // Log error but don't fail the transaction insert since the primary write succeeded
      console.error(`Failed to insert payment ${paymentData.squareId} into payments table:`, error);
      
      // Record the failure for potential later reconciliation
      // This ensures we can identify and fix any failures during the transition
      try {
        await db.execute(sql`
          INSERT INTO sync_state (
            sync_type, last_synced_at, processed_count, status, last_checkpoint
          ) VALUES (
            'payment_dual_write_failure', 
            CURRENT_TIMESTAMP, 
            1, 
            'failed',
            ${JSON.stringify({
              squareId: paymentData.squareId,
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString()
            })}::jsonb
          )
        `);
      } catch (syncError) {
        console.error('Failed to record sync failure:', syncError);
      }
      
      // Schedule an automatic reconciliation attempt to fix this payment later
      setTimeout(async () => {
        try {
          console.log(`Attempting auto-reconciliation for failed payment ${paymentData.squareId}`);
          await this.syncMissingPayments(
            new Date(paymentData.timestamp.getTime() - 60 * 1000), // 1 minute before
            new Date(paymentData.timestamp.getTime() + 60 * 1000)  // 1 minute after
          );
        } catch (reconcileError) {
          console.error('Auto-reconciliation failed:', reconcileError);
        }
      }, 5000); // Try after 5 seconds
    }
    
    // STEP 3: Process gift card redemption if this payment was made with a gift card
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
  
  /**
   * Synchronize missing payment records from transactions to payments table
   * 
   * This method is part of the dual-track strategy for architecture transition:
   * 
   * 1. RETROSPECTIVE FIX: It addresses the immediate issue of missing records that 
   *    occurred on March 6, 2025, and any potential future gaps.
   * 
   * 2. SPECIFIC PURPOSE: The default date range specifically targets the known data gap
   *    starting from March 6, 2025 04:13:41 UTC, which is when the architectural 
   *    transition began.
   * 
   * 3. IDEMPOTENT DESIGN: It's designed to be safely run multiple times, using
   *    NOT EXISTS and ON CONFLICT DO NOTHING to avoid duplicating data.
   * 
   * This special reconciliation tool should be run once after deployment to fix
   * the 37 missing records, and can be used again in the future if similar
   * gap situations occur.
   * 
   * @param startDate Optional start date for sync (default: March 6, 2025 04:13:41 UTC)
   * @param endDate Optional end date for sync (default: current time)
   * @returns Summary of synchronization results with counts and error details
   */
  async syncMissingPayments(
    startDate: Date = new Date('2025-03-06T04:13:41.000Z'),
    endDate: Date = new Date()
  ): Promise<{ 
    totalProcessed: number; 
    succeeded: number; 
    failed: number; 
    errors: any[];
  }> {
    console.log(`Synchronizing missing payments from ${startDate.toISOString()} to ${endDate.toISOString()}`);
    
    // Log the critical information about this operation
    console.log('RECONCILIATION: This operation specifically targets the architectural transition gap');
    console.log('IMPORTANT: This is a one-time fix for historical data inconsistency');
    
    // Initialize the results object
    const results = {
      totalProcessed: 0,
      succeeded: 0,
      failed: 0,
      errors: [] as any[]
    };
    
    try {
      // Step 1: Count the total number of transactions in the date range
      const countResult = await db.execute(sql`
        SELECT COUNT(*) as total FROM transactions
        WHERE timestamp BETWEEN ${startDate} AND ${endDate}
      `);
      
      // Safely access the first row and handle the result properly for TypeScript
      const totalCount = parseInt(countResult.rows?.[0]?.total?.toString() || '0', 10);
      results.totalProcessed = totalCount;
      
      console.log(`Found ${totalCount} transactions in the date range`);
      
      // Step 2: Use a direct SQL approach to insert all missing records at once
      // This is much more efficient and avoids potential syntax issues with individual inserts
      const insertResult = await db.execute(sql`
        WITH inserted_rows AS (
          INSERT INTO payments 
            (square_id, status, amount, tip_amount, tax_amount, timestamp, currency, is_gift_card_activation, metadata)
          SELECT 
            t.square_id,
            t.status,
            t.amount,
            0,
            0,
            t.timestamp,
            'USD',
            (t.category_id = 'giftCard'),
            '{}'::jsonb
          FROM transactions t
          WHERE 
            t.timestamp BETWEEN ${startDate} AND ${endDate}
            AND NOT EXISTS (
              SELECT 1 FROM payments p WHERE p.square_id = t.square_id
            )
          RETURNING square_id
        )
        SELECT COUNT(*) as inserted_count FROM inserted_rows
      `);
      
      // Get the count of inserted rows with proper TypeScript handling
      const insertedCount = parseInt(insertResult.rows?.[0]?.inserted_count?.toString() || '0', 10);
      results.succeeded = insertedCount;
      
      console.log(`Successfully inserted ${insertedCount} missing payment records`);
      
      // Step 3: Now verify the total count in the payments table
      const verifyResult = await db.execute(sql`
        SELECT COUNT(*) as synced_count FROM payments p
        JOIN transactions t ON p.square_id = t.square_id
        WHERE t.timestamp BETWEEN ${startDate} AND ${endDate}
      `);
      
      // Safely access the row and properly handle type conversion for TypeScript
      const syncedCount = parseInt(verifyResult.rows?.[0]?.synced_count?.toString() || '0', 10);
      
      console.log(`Verification: ${syncedCount} of ${totalCount} transactions now have corresponding payment records`);
      
      // Record this reconciliation in the sync_state table for audit purposes
      try {
        await db.execute(sql`
          INSERT INTO sync_state (
            sync_type, last_synced_at, processed_count, status, last_checkpoint
          ) VALUES (
            'missing_payments_reconciliation', 
            CURRENT_TIMESTAMP, 
            ${insertedCount}, 
            'completed',
            ${JSON.stringify({
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString(),
              totalTransactions: totalCount,
              insertedPayments: insertedCount,
              totalSynced: syncedCount
            })}::jsonb
          )
        `);
        console.log('Recorded sync state successfully');
      } catch (syncError) {
        console.error('Failed to record sync state:', syncError);
      }
      
    } catch (error) {
      console.error('Error during payment reconciliation:', error);
      results.failed = 1;
      results.errors.push({
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Try to record the error in sync_state table
      try {
        await db.execute(sql`
          INSERT INTO sync_state (
            sync_type, last_synced_at, processed_count, status, last_checkpoint
          ) VALUES (
            'missing_payments_reconciliation_error', 
            CURRENT_TIMESTAMP, 
            0, 
            'failed',
            ${JSON.stringify({
              startDate: startDate.toISOString(),
              endDate: endDate.toISOString(),
              error: error instanceof Error ? error.message : String(error)
            })}::jsonb
          )
        `);
      } catch (syncError) {
        console.error('Failed to record sync error:', syncError);
      }
    }
    
    return results;
  }
}

// Create and export a singleton instance
export const paymentService = new PaymentService();