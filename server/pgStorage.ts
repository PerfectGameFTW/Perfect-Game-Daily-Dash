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
    
    if (startDate) {
      // First convert the input dates to their Eastern Time representation
      // This is crucial for proper day boundary alignment
      const startInEastern = toZonedTime(startDate, this.EASTERN_TIMEZONE);
      const endInEastern = endDate ? toZonedTime(endDate, this.EASTERN_TIMEZONE) : startInEastern;
      
      // Get the date strings in Eastern Time (format: YYYY-MM-DD)
      const startDateStr = format(startInEastern, 'yyyy-MM-dd');
      const endDateStr = format(endInEastern, 'yyyy-MM-dd');
      
      // Calculate start time: midnight (00:00:00.000) Eastern Time on start date
      // During EST (UTC-5), midnight ET = 05:00:00 UTC
      // During EDT (UTC-4), midnight ET = 04:00:00 UTC
      // We'll use UTC directly with the correct offset
      
      // For Eastern Standard Time (winter), midnight is 05:00 UTC
      // This is the case in February 2025
      const easternMidnightStart = new Date(`${startDateStr}T05:00:00.000Z`);
      
      // For end time, we want 23:59:59.999 Eastern Time on end date
      // During EST, 23:59:59.999 ET = 04:59:59.999 UTC of the next day
      // Get the next day after the end date for proper end time
      const nextDayDate = new Date(endDateStr);
      nextDayDate.setDate(nextDayDate.getDate() + 1);
      const nextDayStr = format(nextDayDate, 'yyyy-MM-dd');
      const easternMidnightEnd = new Date(`${nextDayStr}T04:59:59.999Z`);
      
      console.log(`UNIVERSAL TIMEZONE HANDLING - Eastern Time business day for ${startDateStr} to ${endDateStr}:`, {
        start: easternMidnightStart.toISOString(),
        end: easternMidnightEnd.toISOString(),
        easternStart: formatInTimeZone(easternMidnightStart, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        easternEnd: formatInTimeZone(easternMidnightEnd, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
      
      return { start: easternMidnightStart, end: easternMidnightEnd };
    }
    
    // UNIVERSAL SOLUTION FOR ALL DATE RANGES
    // We use the same approach for all dates - consistently use Eastern Time business day definitions
    // During EST: 5:00 UTC to 4:59:59.999 UTC the next day
    // During EDT: 4:00 UTC to 3:59:59.999 UTC the next day
    
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
      // For custom range, convert input dates to Eastern Time representation
      const startInEastern = toZonedTime(startDate, this.EASTERN_TIMEZONE);
      const endInEastern = endDate ? toZonedTime(endDate, this.EASTERN_TIMEZONE) : startInEastern;
      
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
    
    // Now consistently convert Eastern dates to UTC database query format
    // During EST (UTC-5):
    //   - 00:00:00 Eastern = 05:00:00 UTC same day
    //   - 23:59:59 Eastern = 04:59:59 UTC next day
    
    // Get current offset for the Eastern timezone
    // For EST (winter), the offset is 5 hours behind UTC (-5)
    // For EDT (summer), the offset is 4 hours behind UTC (-4)
    // We'll implement a more dynamic approach that works for both
    
    // Get a reference date object for this date to check DST
    const dateForOffset = new Date(`${startDateStr}T12:00:00.000Z`); // Noon UTC to avoid date boundary issues
    const easternDate = toZonedTime(dateForOffset, this.EASTERN_TIMEZONE);
    // Get the timezone string to check if we're in EDT or EST
    const tzString = formatInTimeZone(easternDate, this.EASTERN_TIMEZONE, 'zzz');
    
    let utcOffset: number;
    if (tzString === 'EDT') {
      // Eastern Daylight Time (UTC-4)
      utcOffset = 4;
    } else {
      // Eastern Standard Time (UTC-5)
      utcOffset = 5;
    }
    
    console.log(`Using timezone offset of UTC-${utcOffset} for ${startDateStr} (${tzString})`);
    
    // Create start time: midnight (00:00:00) Eastern Time = utcOffset:00:00 UTC
    const utcStart = new Date(`${startDateStr}T${utcOffset.toString().padStart(2, '0')}:00:00.000Z`);
    
    // Create end time: 11:59:59 PM Eastern Time = (utcOffset-1):59:59 UTC of the next day
    // Get the next day after the end date
    const nextDayDate = new Date(endDateStr);
    nextDayDate.setDate(nextDayDate.getDate() + 1);
    const nextDayStr = format(nextDayDate, 'yyyy-MM-dd');
    // Set to (utcOffset-1):59:59.999 UTC of next day (11:59:59.999 PM Eastern)
    const utcEnd = new Date(`${nextDayStr}T${(utcOffset-1).toString().padStart(2, '0')}:59:59.999Z`);
    
    // Add transaction diagnostics for any date range being analyzed
    // This helps us verify that our timezone calculations are working correctly
    setTimeout(async () => {
      try {
        // Get the date strings (for display purposes)
        const startDateStr = formatInTimeZone(utcStart, this.EASTERN_TIMEZONE, 'yyyy-MM-dd');
        const endDateStr = formatInTimeZone(utcEnd, this.EASTERN_TIMEZONE, 'yyyy-MM-dd');
        
        // Get total transaction count from database
        const totalCount = await db.select({ count: sql`count(*)` })
          .from(transactions);
        console.log('DIAGNOSTIC - Total transactions in database:', totalCount[0]);
        
        // Count total transactions in the requested date range
        const rangeCount = await db.select({ count: sql`count(*)` })
          .from(transactions)
          .where(
            and(
              gte(transactions.timestamp, utcStart),
              lte(transactions.timestamp, utcEnd)
            )
          );
          
        // Count completed transactions in the requested date range
        const completedCount = await db.select({ count: sql`count(*)` })
          .from(transactions)
          .where(
            and(
              gte(transactions.timestamp, utcStart),
              lte(transactions.timestamp, utcEnd),
              eq(transactions.status, 'completed')
            )
          );
          
        console.log(`DIAGNOSTIC - Transactions count for ${startDateStr} to ${endDateStr}:`, {
          total: rangeCount[0],
          completed: completedCount[0],
          start: utcStart.toISOString(),
          end: utcEnd.toISOString(),
        });
      } catch (err) {
        console.error('Error analyzing transactions:', err);
      }
    }, 1000); // Run in background to not block the main request
    
    console.log('FINAL DATABASE QUERY RANGE:', {
      utcStart: utcStart.toISOString(),
      utcEnd: utcEnd.toISOString(),
      easternStart: formatInTimeZone(utcStart, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
      easternEnd: formatInTimeZone(utcEnd, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
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