import { 
  Transaction, InsertTransaction, 
  GiftCard, InsertGiftCard, 
  GiftCardRedemption, InsertGiftCardRedemption,
  User, InsertUser,
  SyncState, InsertSyncState,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  DateRange, TransactionStatus,
  transactions, giftCards, giftCardRedemptions, users, syncState
} from "@shared/schema";
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { IStorage } from "./storage";
import pg from "pg";
const { Pool } = pg;
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, gte, lte, SQL, sql } from "drizzle-orm";
import dotenv from 'dotenv';

dotenv.config();

// Initialize PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Initialize Drizzle
export const db = drizzle(pool);

export class PgStorage implements IStorage {
  // User methods
  async getUser(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  // Transaction methods
  async getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date, status: TransactionStatus = 'completed'): Promise<Transaction[]> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    const result = await db.select()
      .from(transactions)
      .where(
        and(
          gte(transactions.timestamp, start),
          lte(transactions.timestamp, end),
          eq(transactions.status, status)
        )
      )
      .orderBy(sql`${transactions.timestamp} DESC`);
    
    return result;
  }

  async getTransactionById(id: number): Promise<Transaction | undefined> {
    const result = await db.select().from(transactions).where(eq(transactions.id, id));
    return result[0];
  }

  async getTransactionBySquareId(squareId: string): Promise<Transaction | undefined> {
    const result = await db.select().from(transactions).where(eq(transactions.squareId, squareId));
    return result[0];
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    const result = await db.insert(transactions).values(insertTransaction).returning();
    return result[0];
  }

  // Gift card methods
  async getGiftCards(): Promise<GiftCard[]> {
    return await db.select().from(giftCards);
  }

  async getGiftCardById(id: number): Promise<GiftCard | undefined> {
    const result = await db.select().from(giftCards).where(eq(giftCards.id, id));
    return result[0];
  }

  async getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined> {
    const result = await db.select().from(giftCards).where(eq(giftCards.squareId, squareId));
    return result[0];
  }

  async createGiftCard(insertGiftCard: InsertGiftCard): Promise<GiftCard> {
    const result = await db.insert(giftCards).values(insertGiftCard).returning();
    return result[0];
  }

  async updateGiftCardRedemption(id: number, amount: number): Promise<GiftCard> {
    const giftCard = await this.getGiftCardById(id);
    if (!giftCard) {
      throw new Error(`Gift card with id ${id} not found`);
    }
    
    const result = await db.update(giftCards)
      .set({ redeemedAmount: giftCard.redeemedAmount + amount })
      .where(eq(giftCards.id, id))
      .returning();
    
    return result[0];
  }

  // Gift card redemption methods
  async createGiftCardRedemption(insertRedemption: InsertGiftCardRedemption): Promise<GiftCardRedemption> {
    const result = await db.insert(giftCardRedemptions).values(insertRedemption).returning();
    
    // Update the gift card's redeemed amount
    await this.updateGiftCardRedemption(insertRedemption.giftCardId, insertRedemption.amount);
    
    return result[0];
  }

  async getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]> {
    return await db.select()
      .from(giftCardRedemptions)
      .where(eq(giftCardRedemptions.giftCardId, giftCardId))
      .orderBy(sql`${giftCardRedemptions.timestamp} DESC`);
  }

  // Dashboard summary methods
  async getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    // Note: We've removed special case handling for "today" - all data is now consistently
    // processed from the database regardless of date
    
    // Calculate previous period
    const daysDiff = Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - daysDiff);
    const prevEnd = new Date(end);
    prevEnd.setDate(prevEnd.getDate() - daysDiff);
    
    // Current period transactions
    const currentTransactions = await this.getTransactions(dateRange, start, end);
    
    // Previous period transactions - only get completed transactions
    const prevTransactions = await db.select()
      .from(transactions)
      .where(
        and(
          gte(transactions.timestamp, prevStart),
          lte(transactions.timestamp, prevEnd),
          eq(transactions.status, 'completed')
        )
      );
    
    // Calculate current period metrics - only count completed transactions
    const completedTransactions = currentTransactions.filter(t => t.status === 'completed');
    const totalRevenue = completedTransactions.reduce((sum, t) => sum + t.amount, 0);
    const totalOrders = completedTransactions.length;
    const averageOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    
    // Gift card sales - only count completed transactions
    const giftCardSales = completedTransactions
      .filter(t => t.categoryId === 'giftCard')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Calculate previous period metrics for change percentages - only count completed transactions
    const completedPrevTransactions = prevTransactions.filter(t => t.status === 'completed');
    const prevTotalRevenue = completedPrevTransactions.reduce((sum, t) => sum + t.amount, 0);
    const prevTotalOrders = completedPrevTransactions.length;
    const prevAverageOrder = prevTotalOrders > 0 ? prevTotalRevenue / prevTotalOrders : 0;
    const prevGiftCardSales = completedPrevTransactions
      .filter(t => t.categoryId === 'giftCard')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Calculate change percentages
    const revenueChange = prevTotalRevenue > 0 
      ? ((totalRevenue - prevTotalRevenue) / prevTotalRevenue) * 100 
      : 0;
    const ordersChange = prevTotalOrders > 0 
      ? ((totalOrders - prevTotalOrders) / prevTotalOrders) * 100 
      : 0;
    const averageOrderChange = prevAverageOrder > 0 
      ? ((averageOrder - prevAverageOrder) / prevAverageOrder) * 100 
      : 0;
    const giftCardSalesChange = prevGiftCardSales > 0 
      ? ((giftCardSales - prevGiftCardSales) / prevGiftCardSales) * 100 
      : 0;
    
    return {
      totalRevenue,
      revenueChange,
      totalOrders,
      ordersChange,
      averageOrder,
      averageOrderChange,
      giftCardSales,
      giftCardSalesChange,
      date: format(end, 'MMMM d, yyyy')
    };
  }

  async getCategoryRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<CategoryRevenue[]> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    // Define category colors matching the design
    const categoryColors: Record<string, string> = {
      food: '#3B82F6',
      drinks: '#6366F1',
      retail: '#8B5CF6',
      services: '#10B981',
      giftCard: '#F59E0B'
    };
    
    // Note: We've removed special case handling for "today" - all data is now consistently
    // processed from the database regardless of date
    
    const currentTransactions = await this.getTransactions(dateRange, start, end);
    
    // Group by category and calculate totals - only count completed transactions
    const categoryMap = new Map<string, number>();
    
    const completedTransactions = currentTransactions.filter(t => t.status === 'completed');
    completedTransactions.forEach(transaction => {
      const currentAmount = categoryMap.get(transaction.categoryId) || 0;
      categoryMap.set(transaction.categoryId, currentAmount + transaction.amount);
    });
    
    // Format the result
    return Array.from(categoryMap.entries()).map(([category, amount]) => ({
      category: category.charAt(0).toUpperCase() + category.slice(1),
      amount,
      color: categoryColors[category] || '#3B82F6' // Default to primary color
    }));
  }

  async getHourlyRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<HourlyRevenue[]> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    // Initialize hourly buckets (midnight to 11 PM)
    const hourlyMap = new Map<string, number>();
    
    for (let hour = 0; hour <= 23; hour++) {
      const formattedHour = hour === 0 
        ? '12 AM' 
        : hour < 12 
          ? `${hour} AM` 
          : hour === 12 
            ? '12 PM' 
            : `${hour - 12} PM`;
      hourlyMap.set(formattedHour, 0);
    }
    
    // Note: We've removed special case handling for "today" - all data is now consistently
    // processed from the database regardless of date
    
    const currentTransactions = await this.getTransactions(dateRange, start, end);
    
    // Group transactions by hour - only count completed transactions
    const completedTransactions = currentTransactions.filter(t => t.status === 'completed');
    completedTransactions.forEach(transaction => {
      // Convert transaction timestamp to Eastern time for proper hour grouping
      const utcDate = new Date(transaction.timestamp);
      const easternDate = toZonedTime(utcDate, this.EASTERN_TIMEZONE);
      const hour = easternDate.getHours();
      
      const formattedHour = hour === 0 
        ? '12 AM' 
        : hour < 12 
          ? `${hour} AM` 
          : hour === 12 
            ? '12 PM' 
            : `${hour - 12} PM`;
            
      const currentAmount = hourlyMap.get(formattedHour) || 0;
      hourlyMap.set(formattedHour, currentAmount + transaction.amount);
    });
    
    // Format the result, maintaining the 24-hour order
    return Array.from(hourlyMap.entries()).map(([hour, amount]) => ({
      hour,
      amount
    }));
  }

  async getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    console.log(`Gift Card Summary - Date Range: ${start.toISOString()} to ${end.toISOString()}`);
    
    // IMPROVED: Get transactions specifically for gift card sales
    // We need to query completed transactions directly with categoryId = 'giftCard'
    const giftCardSales = await db.select()
      .from(transactions)
      .where(
        and(
          eq(transactions.categoryId, 'giftCard'),
          eq(transactions.status, 'completed'),  // Only include completed transactions
          gte(transactions.timestamp, start),
          lte(transactions.timestamp, end)
        )
      );
    
    // Logging to help with diagnostics
    console.log(`Found ${giftCardSales.length} gift card transactions in database for this period`);
    const dbAmount = giftCardSales.reduce((sum, sale) => sum + sale.amount, 0);
    console.log(`Database reports $${dbAmount.toFixed(2)} in gift card sales for this period`);
    
    // Get gift card redemptions
    const redemptions = await db.select()
      .from(giftCardRedemptions)
      .where(
        and(
          gte(giftCardRedemptions.timestamp, start),
          lte(giftCardRedemptions.timestamp, end)
        )
      );
    
    // Calculate gift card sales (already filtered for completed transactions in the query)
    const soldCount = giftCardSales.length;
    const soldAmount = giftCardSales.reduce((sum, t) => sum + t.amount, 0);
    
    // Calculate gift card redemptions
    const redeemedCount = redemptions.length;
    const redeemedAmount = redemptions.reduce((sum, r) => sum + r.amount, 0);
    
    // Calculate average gift card value
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    
    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue
    };
  }
  
  // Define Eastern Time Zone
  private readonly EASTERN_TIMEZONE = 'America/New_York';
  
  // Helper method for date range calculations with Eastern timezone awareness
  private getDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
    // Create 'now' in Eastern timezone for calculations
    const now = new Date();
    // Set timezone to Eastern Time
    const easternNow = toZonedTime(now, this.EASTERN_TIMEZONE);
    
    // These will hold our Eastern timezone dates
    let easternStart: Date;
    let easternEnd: Date;
    
    // If explicit dates are provided, they take precedence over the dateRange
    if (startDate && (dateRange === 'custom' || endDate)) {
      // For custom range or when both dates are specified
      // Convert the dates to Eastern timezone for proper day boundaries
      const easternStartDate = toZonedTime(startDate, this.EASTERN_TIMEZONE);
      const easternEndDate = endDate ? toZonedTime(endDate, this.EASTERN_TIMEZONE) : easternStartDate;
      
      // Apply start and end of day in Eastern timezone
      easternStart = startOfDay(easternStartDate);
      easternEnd = endOfDay(easternEndDate);
      
      console.log('Using explicit date range (Eastern Time):', {
        dateRange,
        easternStart: formatInTimeZone(easternStart, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        easternEnd: formatInTimeZone(easternEnd, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
    } else {
      // Otherwise, use the predefined dateRange in Eastern timezone
      switch (dateRange) {
        case 'today':
          easternStart = startOfDay(easternNow);
          easternEnd = endOfDay(easternNow);
          break;
        case 'yesterday':
          easternStart = startOfDay(subDays(easternNow, 1));
          easternEnd = endOfDay(subDays(easternNow, 1));
          break;
        case 'last7days':
          easternStart = startOfDay(subDays(easternNow, 6));
          easternEnd = endOfDay(easternNow);
          break;
        case 'last30days':
          easternStart = startOfDay(subDays(easternNow, 29));
          easternEnd = endOfDay(easternNow);
          break;
        case 'thisMonth':
          easternStart = startOfMonth(easternNow);
          easternEnd = endOfMonth(easternNow);
          break;
        case 'lastMonth':
          const lastMonth = subDays(startOfMonth(easternNow), 1);
          easternStart = startOfMonth(lastMonth);
          easternEnd = endOfMonth(lastMonth);
          break;
        case 'custom':
          // Should only get here if custom range was selected without dates
          throw new Error('Start date and end date must be provided for custom date range');
        default:
          easternStart = startOfDay(easternNow);
          easternEnd = endOfDay(easternNow);
      }
      
      console.log('Using predefined date range (Eastern Time):', {
        dateRange,
        easternStart: formatInTimeZone(easternStart, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        easternEnd: formatInTimeZone(easternEnd, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
    }
    
    // FIXED: Convert Eastern Time dates to correct UTC equivalents for database query
    // The database stores UTC timestamps, but we want to query based on
    // Eastern Time business days (midnight to midnight in Eastern Time)
    
    // We need the UTC date/time that corresponds to:
    // 1. 00:00:00.000 Eastern Time on the start date
    // 2. 23:59:59.999 Eastern Time on the end date
    
    // For Eastern Time -> UTC in Feb 2025 (EST, UTC-5):
    // - 00:00:00 EST = 05:00:00 UTC same day
    // - 23:59:59 EST = 04:59:59 UTC next day

    // Create date objects with day boundaries in Eastern Time
    const easternStartStr = `${easternStart.getFullYear()}-${String(easternStart.getMonth() + 1).padStart(2, '0')}-${String(easternStart.getDate()).padStart(2, '0')}T00:00:00`;
    const easternEndStr = `${easternEnd.getFullYear()}-${String(easternEnd.getMonth() + 1).padStart(2, '0')}-${String(easternEnd.getDate()).padStart(2, '0')}T23:59:59.999`;
    
    // Parse these strings as Eastern Time dates
    const easternStartMidnight = toZonedTime(new Date(easternStartStr), this.EASTERN_TIMEZONE);
    const easternEndMidnight = toZonedTime(new Date(easternEndStr), this.EASTERN_TIMEZONE);
    
    // Convert Eastern Time dates to their UTC equivalents
    // This gives us the correct UTC time that corresponds to the Eastern Time boundaries
    const utcStart = new Date(easternStartMidnight.valueOf() - (easternStartMidnight.getTimezoneOffset() * 60000));
    const utcEnd = new Date(easternEndMidnight.valueOf() - (easternEndMidnight.getTimezoneOffset() * 60000));
    
    console.log('Converted to UTC for database query:', {
      utcStart: utcStart.toISOString(),
      utcEnd: utcEnd.toISOString(),
      easternStart: formatInTimeZone(easternStartMidnight, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
      easternEnd: formatInTimeZone(easternEndMidnight, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
    });
    
    return { start: utcStart, end: utcEnd };
  }
  
  // Sync state management methods
  async getSyncState(syncType: string): Promise<SyncState | undefined> {
    const result = await db.select()
      .from(syncState)
      .where(eq(syncState.syncType, syncType));
    return result[0];
  }

  async createSyncState(syncStateData: InsertSyncState): Promise<SyncState> {
    const result = await db.insert(syncState)
      .values(syncStateData)
      .returning();
    return result[0];
  }

  async updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState> {
    const result = await db.update(syncState)
      .set(updates)
      .where(eq(syncState.id, id))
      .returning();
    return result[0];
  }
  
  async getSyncProgress(): Promise<{ payments: number; giftCards: number }> {
    // Get the payments sync state
    const paymentsSyncState = await this.getSyncState('payments');
    const giftCardsSyncState = await this.getSyncState('giftCards');
    
    // Calculate progress percentages
    const paymentsProgress = paymentsSyncState && paymentsSyncState.totalCount && paymentsSyncState.totalCount > 0
      ? Math.min(100, Math.round(((paymentsSyncState.processedCount || 0) / paymentsSyncState.totalCount) * 100))
      : 0;
      
    const giftCardsProgress = giftCardsSyncState && giftCardsSyncState.totalCount && giftCardsSyncState.totalCount > 0
      ? Math.min(100, Math.round(((giftCardsSyncState.processedCount || 0) / giftCardsSyncState.totalCount) * 100))
      : 0;
    
    return {
      payments: paymentsProgress,
      giftCards: giftCardsProgress
    };
  }
}

export const pgStorage = new PgStorage();