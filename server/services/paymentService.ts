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
    const result = await db.insert(transactions).values(paymentData).returning();
    
    if (!result.length) {
      throw new PaymentError('Failed to create payment', 'DB_ERROR');
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
}

// Helper function to format hour number to AM/PM string
function formatHour(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour === 12) return '12 PM';
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

// Create and export a singleton instance
export const paymentService = new PaymentService();