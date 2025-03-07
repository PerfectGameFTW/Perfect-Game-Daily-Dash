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
   * Create a new payment
   * 
   * @param paymentData The payment data to insert
   * @returns The created payment
   */
  async createPayment(paymentData: InsertTransaction): Promise<Transaction> {
    // First, insert into the transactions table as before
    const result = await db.insert(transactions).values(paymentData).returning();
    
    if (!result.length) {
      throw new PaymentError('Failed to create payment', 'DB_ERROR');
    }
    
    // Now also insert into the payments table for the new system
    try {
      // Extract data from Square transaction to populate payments table
      const squareData = paymentData.squareData || {};
      // Cast to any to access nested properties
      const squareDataObject = squareData as any;
      
      // Build payment record based on transaction data
      await db.execute(sql`
        INSERT INTO payments (
          square_id, status, amount, tip_amount, tax_amount, timestamp, 
          currency, square_order_id, receipt_url, is_gift_card_activation, metadata
        ) VALUES (
          ${paymentData.squareId},
          ${paymentData.status},
          ${paymentData.amount},
          ${squareDataObject.tipMoney?.amount ? parseFloat(squareDataObject.tipMoney.amount) / 100 : 0},
          ${squareDataObject.taxMoney?.amount ? parseFloat(squareDataObject.taxMoney.amount) / 100 : 0},
          ${paymentData.timestamp},
          ${squareDataObject.currency || 'USD'},
          ${squareDataObject.orderId || null},
          ${squareDataObject.receiptUrl || null},
          ${paymentData.categoryId === 'giftCard'},
          ${JSON.stringify(squareData)}
        )
        ON CONFLICT (square_id) DO NOTHING
      `);
      
      console.log(`Inserted payment ${paymentData.squareId} into both transactions and payments tables`);
    } catch (error) {
      // Log error but don't fail the transaction insert
      console.error('Failed to insert into payments table:', error);
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
    
    // Build query with proper filters
    let query = db.select().from(transactions)
      .where(and(
        between(transactions.timestamp, start, end)
      ))
      .orderBy(desc(transactions.timestamp));
    
    // Add status filter if provided
    if (status) {
      query = query.where(eq(transactions.status, status));
    }
    
    // Add limit if provided
    if (limit && limit > 0) {
      query = query.limit(limit);
    }
    
    return await query;
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
   * @param startDate Optional start date for sync (default: March 6, 2025 04:13:41 UTC)
   * @param endDate Optional end date for sync (default: current time)
   * @returns Summary of synchronization results
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
    
    // Get transactions that need to be synced
    const missingTransactions = await db.select()
      .from(transactions)
      .where(
        and(
          between(transactions.timestamp, startDate, endDate),
          sql`NOT EXISTS (
            SELECT 1 FROM payments 
            WHERE payments.square_id = ${transactions.squareId}
          )`
        )
      )
      .orderBy(asc(transactions.timestamp));
    
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
        
        // Insert into payments table
        await db.execute(sql`
          INSERT INTO payments (
            square_id, status, amount, tip_amount, tax_amount, timestamp, 
            currency, square_order_id, receipt_url, is_gift_card_activation, metadata
          ) VALUES (
            ${transaction.squareId},
            ${transaction.status},
            ${transaction.amount},
            ${squareDataObject.tipMoney?.amount ? parseFloat(squareDataObject.tipMoney.amount) / 100 : 0},
            ${squareDataObject.taxMoney?.amount ? parseFloat(squareDataObject.taxMoney.amount) / 100 : 0},
            ${transaction.timestamp},
            ${squareDataObject.currency || 'USD'},
            ${squareDataObject.orderId || null},
            ${squareDataObject.receiptUrl || null},
            ${transaction.categoryId === 'giftCard'},
            ${JSON.stringify(squareData)}
          )
          ON CONFLICT (square_id) DO NOTHING
        `);
        
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