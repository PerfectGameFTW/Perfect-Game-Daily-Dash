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
import { getEasternDateRange } from '../dateUtils';

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
      // Extract data from Square transaction to populate payments table
      const squareData = paymentData.squareData || {};
      const squareDataObject = squareData as any;
      
      // Extract specific fields from Square data with proper type handling
      const tipAmount = squareDataObject.tipMoney?.amount 
        ? parseFloat(squareDataObject.tipMoney.amount) / 100 
        : 0;
        
      const taxAmount = squareDataObject.taxMoney?.amount 
        ? parseFloat(squareDataObject.taxMoney.amount) / 100 
        : 0;
      
      // Currency defaults to USD if not specified
      const currency = squareDataObject.currency || 'USD';
      
      // Determine if this is a gift card activation based on category
      const isGiftCardActivation = paymentData.categoryId === 'giftCard';
      
      // Build payment record with all required fields for the new system
      await db.execute(sql`
        INSERT INTO payments (
          square_id, status, amount, tip_amount, tax_amount, timestamp, 
          currency, square_order_id, receipt_url, is_gift_card_activation, metadata
        ) VALUES (
          ${paymentData.squareId},
          ${paymentData.status},
          ${paymentData.amount},
          ${tipAmount},
          ${taxAmount},
          ${paymentData.timestamp},
          ${currency},
          ${squareDataObject.orderId || null},
          ${squareDataObject.receiptUrl || null},
          ${isGiftCardActivation},
          ${JSON.stringify(squareData)}
        )
        ON CONFLICT (square_id) DO NOTHING
      `);
      
      console.log(`Successfully wrote payment ${paymentData.squareId} to both transactions and payments tables`);
    } catch (error) {
      // Log error but don't fail the transaction insert since the primary write succeeded
      console.error(`Failed to insert payment ${paymentData.squareId} into payments table:`, error);
      
      // Record the failure for potential later reconciliation
      // This ensures we can identify and fix any failures during the transition
      try {
        await db.execute(sql`
          INSERT INTO sync_state (sync_type, last_synced, record_count, status, error_details)
          VALUES ('payment_dual_write_failure', NOW(), 1, 'failed', ${JSON.stringify({
            squareId: paymentData.squareId,
            error: error instanceof Error ? error.message : String(error)
          })})
        `);
      } catch (syncError) {
        console.error('Failed to record sync failure:', syncError);
      }
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
    
    // Query the database for the total revenue
    const result = await db.select({
      totalRevenue: sql<number>`COALESCE(SUM(${transactions.amount}), 0)`,
    }).from(transactions)
      .where(and(
        between(transactions.timestamp, start, end),
        eq(transactions.status, 'completed')
      ));
    
    return result[0]?.totalRevenue || 0;
  }
  
  /**
   * Get hourly revenue for the specified date range
   * 
   * @param dateRange The date range type (today, yesterday, etc.)
   * @param startDate Optional custom start date for custom ranges
   * @param endDate Optional custom end date for custom ranges
   * @returns Array of hourly revenue data
   */
  async getHourlyRevenue(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date
  ): Promise<{ hour: string, amount: number }[]> {
    // Get proper UTC date boundaries based on Eastern business days
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Query the database for hourly revenue
    // This complex query extracts the hour from the timestamp in Eastern time
    // and aggregates the revenue by hour
    const result = await db.execute<{ hour: number, amount: number }>(sql`
      SELECT 
        EXTRACT(HOUR FROM ${transactions.timestamp} AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York') AS hour,
        COALESCE(SUM(${transactions.amount}), 0) AS amount
      FROM ${transactions}
      WHERE ${transactions.timestamp} BETWEEN ${start} AND ${end}
        AND ${transactions.status} = 'completed'
      GROUP BY hour
      ORDER BY hour
    `);
    
    // Format hours as strings like "12 AM", "1 PM", etc.
    return result.rows.map(row => ({
      hour: formatHour(row.hour),
      amount: row.amount
    }));
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
    
    // Get transactions that need to be synced using raw SQL
    const missingTransactionsResult = await db.execute<Transaction>(sql`
      SELECT * FROM ${transactions}
      WHERE ${transactions.timestamp} BETWEEN ${startDate} AND ${endDate}
        AND NOT EXISTS (
          SELECT 1 FROM payments 
          WHERE payments.square_id = ${transactions.squareId}
        )
      ORDER BY ${transactions.timestamp} ASC
    `);
    
    const missingTransactions = missingTransactionsResult.rows;
    
    console.log(`Found ${missingTransactions.length} missing payment records to synchronize`);
    
    // Process results
    const results = {
      totalProcessed: missingTransactions.length,
      succeeded: 0,
      failed: 0,
      errors: [] as any[]
    };
    
    // Process each transaction
    for (const transaction of missingTransactions) {
      try {
        // Get square data
        const squareData = transaction.squareData || {};
        // Cast to any to access nested properties
        const squareDataObject = squareData as any;
        
        // Process and validate data before insert
        const tipAmount = squareDataObject.tipMoney?.amount 
          ? parseFloat(squareDataObject.tipMoney.amount) / 100 
          : 0;
          
        const taxAmount = squareDataObject.taxMoney?.amount 
          ? parseFloat(squareDataObject.taxMoney.amount) / 100 
          : 0;
          
        // Use a simpler approach with minimal parameters
        // Avoid SQL injection by using parameterized queries for all values
        try {
          const isGiftCard = transaction.categoryId === 'giftCard';
          const emptyJsonObj = '{}'; 
            
          // Directly use db.execute with minimal parameters to avoid SQL syntax issues
          await db.execute(sql`
            INSERT INTO payments 
              (square_id, status, amount, tip_amount, tax_amount, timestamp, currency, is_gift_card_activation, metadata) 
            VALUES 
              (${transaction.squareId}, ${transaction.status}, ${transaction.amount}, ${tipAmount}, ${taxAmount}, ${transaction.timestamp}, 'USD', ${isGiftCard}, ${emptyJsonObj}::jsonb)
            ON CONFLICT (square_id) DO NOTHING
          `);
          
          // Log every successful insertion for debugging
          console.log(`Successfully inserted payment for transaction ${transaction.id}`);
        } catch (insertError) {
          console.error('Detailed SQL error during payment insert:', insertError);
          throw new Error(`SQL error: ${insertError.message}`);
        }
        
        results.succeeded++;
        console.log(`Synced transaction ${transaction.id} (${transaction.squareId}) to payments table`);
      } catch (error) {
        results.failed++;
        results.errors.push({
          transactionId: transaction.id,
          squareId: transaction.squareId,
          error: error instanceof Error ? error.message : String(error)
        });
        console.error(`Failed to sync transaction ${transaction.id} (${transaction.squareId}):`, error);
      }
    }
    
    console.log(`Sync complete. Results: ${JSON.stringify(results)}`);
    return results;
  }
}

// Helper function to format hour number to AM/PM string
function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// Create and export a singleton instance
export const paymentService = new PaymentService();