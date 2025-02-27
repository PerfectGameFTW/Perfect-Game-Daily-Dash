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
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth, subMonths, addDays } from "date-fns";
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
    console.log('DIAGNOSTIC - getTransactions start', { dateRange, startDate, endDate, status });
    
    // Get the properly aligned Eastern Time business day boundaries converted to UTC
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    // No special case handling - consistent timezone handling for all dates
    // Diagnostic logging to verify Eastern Time business day boundaries
    console.log('USING EASTERN BUSINESS DAY RANGE:', {
      start: start.toISOString(),
      end: end.toISOString(),
      easternStart: formatInTimeZone(start, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
      easternEnd: formatInTimeZone(end, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
    });
    
    // Add diagnostic query to count total transactions in the database
    const countResult = await db.select({ count: sql`count(*)` }).from(transactions);
    console.log('DIAGNOSTIC - Total transactions in database:', countResult[0]);
    
    // Count transactions in the selected period without status filter
    const periodCountResult = await db.select({ count: sql`count(*)` })
      .from(transactions)
      .where(
        and(
          gte(transactions.timestamp, start),
          lte(transactions.timestamp, end)
        )
      );
      
    // Count transactions in the selected period with status filter
    const statusCountResult = await db.select({ count: sql`count(*)` })
      .from(transactions)
      .where(
        and(
          gte(transactions.timestamp, start),
          lte(transactions.timestamp, end),
          eq(transactions.status, status)
        )
      );
    
    console.log('DIAGNOSTIC - Transactions count for query:', {
      period: periodCountResult[0],
      withStatus: statusCountResult[0],
      start: start.toISOString(),
      end: end.toISOString(),
      status
    });
    
    // Query all transactions within the selected date range
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
    
    console.log(`DIAGNOSTIC - getTransactions result length: ${result.length}`);
    
    // Log first and last timestamp in the results to verify boundaries
    if (result.length > 0) {
      console.log('DIAGNOSTIC - Transaction timestamp boundaries:', {
        first: result[result.length-1].timestamp,
        last: result[0].timestamp
      });
    }
    
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
    // UNIVERSAL SOLUTION: Handle all dates with proper timezone alignment
    // This ensures that all dates are aligned with Eastern Time business days (midnight-to-midnight)
    
    console.log('DIAGNOSTIC - Processing date range request:', { dateRange, startDate, endDate });
    
    // Get the current date in Eastern Time for date range calculations
    const now = new Date();
    const easternNow = toZonedTime(now, this.EASTERN_TIMEZONE);
    const todayEasternStr = format(easternNow, 'yyyy-MM-dd');
    
    // Variables to store our date range
    let startDateStr: string;
    let endDateStr: string;
    
    // Determine date strings based on range type
    if (startDate && (dateRange === 'custom' || endDate)) {
      // *** CRITICAL FIX FOR ALL DATES ***
      // When custom dates are provided, we need to convert them to Eastern Time midnight
      // BUT need to retain the specific day that was selected, not use the UTC day
      
      // Convert to Eastern Time to get the correct date (ignore time)
      let startInEastern = toZonedTime(startDate, this.EASTERN_TIMEZONE);
      let endInEastern = endDate ? toZonedTime(endDate, this.EASTERN_TIMEZONE) : startInEastern;
      
      // Extract just the date components (no time)
      startDateStr = format(startInEastern, 'yyyy-MM-dd');
      endDateStr = format(endInEastern, 'yyyy-MM-dd');
      
      console.log('Custom date range in Eastern Time:', { startDateStr, endDateStr });
    } else {
      // For predefined ranges, calculate the dates in Eastern Time
      switch (dateRange) {
        case 'today':
          startDateStr = todayEasternStr;
          endDateStr = todayEasternStr;
          break;
          
        case 'yesterday':
          const yesterdayEastern = subDays(easternNow, 1);
          startDateStr = format(yesterdayEastern, 'yyyy-MM-dd');
          endDateStr = startDateStr; // Same day range
          break;
          
        case 'last7days':
          startDateStr = format(subDays(easternNow, 6), 'yyyy-MM-dd');
          endDateStr = todayEasternStr;
          break;
          
        case 'last30days':
          startDateStr = format(subDays(easternNow, 29), 'yyyy-MM-dd');
          endDateStr = todayEasternStr;
          break;
          
        case 'thisMonth':
          const firstOfMonth = startOfMonth(easternNow);
          const lastOfMonth = endOfMonth(easternNow);
          startDateStr = format(firstOfMonth, 'yyyy-MM-dd');
          endDateStr = format(lastOfMonth, 'yyyy-MM-dd');
          break;
          
        case 'lastMonth':
          const lastMonthDate = subMonths(easternNow, 1);
          const firstOfLastMonth = startOfMonth(lastMonthDate);
          const lastOfLastMonth = endOfMonth(lastMonthDate);
          startDateStr = format(firstOfLastMonth, 'yyyy-MM-dd');
          endDateStr = format(lastOfLastMonth, 'yyyy-MM-dd');
          break;
          
        case 'custom':
          throw new Error('Start date and end date must be provided for custom date range');
          
        default:
          // Default to today
          startDateStr = todayEasternStr;
          endDateStr = todayEasternStr;
      }
      
      console.log(`Date range ${dateRange} in Eastern Time:`, { startDateStr, endDateStr });
    }
    
    // *** UNIVERSAL SOLUTION FOR ALL DATES ***
    // Create proper Eastern Time business day boundaries
    const startEasternMidnight = `${startDateStr}T00:00:00.000`;
    const endEasternMidnight = `${endDateStr}T23:59:59.999`;
    
    // Get the current timezone (EST or EDT) for the specific dates
    // Create the Eastern Time date objects by:
    // 1. Creating a date object for the time in Eastern timezone
    // 2. Getting the offset between Eastern and UTC
    // 3. Converting back to UTC with proper business hour alignment
    
    // Create date objects with the Eastern midnight times
    const startLocalDate = new Date(`${startDateStr}T00:00:00`);
    const endLocalDate = new Date(`${endDateStr}T23:59:59.999`);
    
    // Calculate the UTC equivalents that represent Eastern midnight
    const startEasternDate = toZonedTime(startLocalDate, this.EASTERN_TIMEZONE);
    const endEasternDate = toZonedTime(endLocalDate, this.EASTERN_TIMEZONE);
    
    // Convert to UTC time to use in database queries
    const startUTC = new Date(startEasternDate.toISOString());
    const endUTC = new Date(endEasternDate.toISOString());
    
    // Log the timezone information and conversions
    const tzString = formatInTimeZone(startUTC, this.EASTERN_TIMEZONE, 'zzz');
    console.log(`Using timezone ${tzString} for dates ${startDateStr} to ${endDateStr}`);
    
    // For diagnostics, show the exact conversions
    console.log(`Eastern midnight to 11:59:59.999 PM converted to UTC:`, {
      easternStartStr: formatInTimeZone(startUTC, this.EASTERN_TIMEZONE, 'yyyy-MM-dd\'T\'HH:mm:ss.SSS zzz'),
      easternEndStr: formatInTimeZone(endUTC, this.EASTERN_TIMEZONE, 'yyyy-MM-dd\'T\'HH:mm:ss.SSS zzz'),
      utcStartStr: startUTC.toISOString(),
      utcEndStr: endUTC.toISOString()
    });
    
    console.log('FINAL DATABASE QUERY RANGE:', {
      utcStart: startUTC.toISOString(),
      utcEnd: endUTC.toISOString(),
      easternStart: formatInTimeZone(startUTC, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
      easternEnd: formatInTimeZone(endUTC, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
    });
    
    // Add diagnostic for transaction counts
    console.log(`USING EASTERN BUSINESS DAY RANGE:`, {
      start: startUTC.toISOString(),
      end: endUTC.toISOString(),
      easternStart: formatInTimeZone(startUTC, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
      easternEnd: formatInTimeZone(endUTC, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
    });
    
    // Transaction diagnostics
    setTimeout(async () => {
      try {
        // Get total transaction count
        const totalCount = await db.select({ count: sql`count(*)` })
          .from(transactions);
        console.log('DIAGNOSTIC - Total transactions in database:', totalCount[0]);
        
        // Count transactions for the current period
        const countQuery = await db.select({ count: sql`count(*)` })
          .from(transactions)
          .where(
            and(
              gte(transactions.timestamp, startUTC),
              lte(transactions.timestamp, endUTC)
            )
          );
          
        // Count completed transactions
        const completedQuery = await db.select({ count: sql`count(*)` })
          .from(transactions)
          .where(
            and(
              gte(transactions.timestamp, startUTC),
              lte(transactions.timestamp, endUTC),
              eq(transactions.status, 'completed')
            )
          );
          
        console.log(`DIAGNOSTIC - Transactions count for query:`, {
          period: countQuery[0],
          withStatus: completedQuery[0],
          start: startUTC.toISOString(),
          end: endUTC.toISOString(),
          status: 'completed'
        });
      } catch (err) {
        console.error('Error in transaction diagnostics:', err);
      }
    }, 100);
    
    return { 
      start: startUTC, 
      end: endUTC 
    };
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