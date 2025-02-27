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
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth, subMonths } from "date-fns";
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
    
    // Check if this is a February 26 query
    const isFeb26 = (startDate?.toISOString().startsWith('2025-02-26') || 
                   (!startDate && dateRange === 'today' && new Date().toISOString().startsWith('2025-02-26')));
    
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
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
    
    // No special case handling for Feb 26 - simply use the properly converted date range from UTC
    // and let the database return all matching transactions naturally
    
    // Normal query flow for other dates
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
    // Keep Feb 26 check for reference (we'll still use it for specialized debugging)
    const isFeb26Request = startDate && 
                          startDate.toISOString().startsWith('2025-02-26') &&
                          (!endDate || endDate.toISOString().startsWith('2025-02-26'));
    
    // Create 'now' in Eastern timezone for calculations
    const now = new Date();
    const easternNow = toZonedTime(now, this.EASTERN_TIMEZONE);
    
    console.log('DIAGNOSTIC - Processing date range request:', { dateRange, startDate, endDate });
    
    // These will hold our Eastern timezone dates with 1am-1am business day boundaries
    let easternStartDate: Date;
    let easternEndDate: Date;
    
    // If explicit dates are provided, they take precedence over the dateRange
    if (startDate && (dateRange === 'custom' || endDate)) {
      // Handle custom date range with precise 1am-1am business day boundaries
      
      // Convert start date to Eastern timezone for proper day boundary
      const startInEastern = toZonedTime(startDate, this.EASTERN_TIMEZONE);
      const startDayEastern = startOfDay(startInEastern);
      
      // For end date, first check if it exists
      let endDayEastern: Date;
      
      if (endDate) {
        // If end date provided, use it
        const endInEastern = toZonedTime(endDate, this.EASTERN_TIMEZONE);
        endDayEastern = startOfDay(endInEastern);
      } else {
        // No end date means single day selection, use start date
        endDayEastern = startDayEastern;
      }
      
      // Start boundary: 1am on start date
      const startBoundary = new Date(startDayEastern);
      startBoundary.setHours(1, 0, 0, 0);
      easternStartDate = startBoundary;
      
      // End boundary: 12:59:59.999am on the day AFTER end date
      const endBoundaryDay = new Date(endDayEastern);
      endBoundaryDay.setDate(endBoundaryDay.getDate() + 1);
      endBoundaryDay.setHours(1, 0, 0, 0);
      const endBoundary = new Date(endBoundaryDay);
      endBoundary.setMilliseconds(-1); // 00:59:59.999
      easternEndDate = endBoundary;
      
      console.log('DIAGNOSTIC - Custom date set to precise 1AM-1AM Eastern business day boundaries:', {
        startDate: formatInTimeZone(startDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        endDate: endDate ? formatInTimeZone(endDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz') : 'none',
        easternStartDate: formatInTimeZone(easternStartDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        easternEndDate: formatInTimeZone(easternEndDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
    } else {
      // Otherwise, use the predefined dateRange but with 1am-1am business day boundaries
      // For predefined ranges, we need to be precise about the business day boundaries
      
      switch (dateRange) {
        case 'today': {
          // Today = 1am today to 1am tomorrow (Eastern Time)
          const today = startOfDay(easternNow);
          
          // Start boundary: 1am today
          const startDate = new Date(today);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am tomorrow
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(1, 0, 0, 0);
          const endDate = new Date(tomorrow);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
        
        case 'yesterday': {
          // Yesterday = 1am yesterday to 1am today (Eastern Time)
          const yesterday = new Date(easternNow);
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStart = startOfDay(yesterday);
          
          // Start boundary: 1am yesterday
          const startDate = new Date(yesterdayStart);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am today
          const today = startOfDay(easternNow);
          const todayOneAM = new Date(today);
          todayOneAM.setHours(1, 0, 0, 0);
          const endDate = new Date(todayOneAM);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
        
        case 'last7days': {
          // Last 7 days = 1am 7 days ago to 1am tomorrow (Eastern Time)
          const sevenDaysAgo = new Date(easternNow);
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
          const sevenDaysAgoStart = startOfDay(sevenDaysAgo);
          
          // Start boundary: 1am 7 days ago
          const startDate = new Date(sevenDaysAgoStart);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am tomorrow
          const tomorrow = new Date(startOfDay(easternNow));
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(1, 0, 0, 0);
          const endDate = new Date(tomorrow);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
        
        case 'last30days': {
          // Last 30 days = 1am 30 days ago to 1am tomorrow (Eastern Time)
          const thirtyDaysAgo = new Date(easternNow);
          thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
          const thirtyDaysAgoStart = startOfDay(thirtyDaysAgo);
          
          // Start boundary: 1am 30 days ago
          const startDate = new Date(thirtyDaysAgoStart);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am tomorrow
          const tomorrow = new Date(startOfDay(easternNow));
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(1, 0, 0, 0);
          const endDate = new Date(tomorrow);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
        
        case 'thisMonth': {
          // This month = 1am first day of month to 1am first day of next month (Eastern Time)
          const firstDayOfMonth = startOfMonth(easternNow);
          
          // Start boundary: 1am first day of month
          const startDate = new Date(firstDayOfMonth);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am first day of next month
          const firstDayOfNextMonth = new Date(firstDayOfMonth);
          firstDayOfNextMonth.setMonth(firstDayOfNextMonth.getMonth() + 1);
          firstDayOfNextMonth.setHours(1, 0, 0, 0);
          const endDate = new Date(firstDayOfNextMonth);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
        
        case 'lastMonth': {
          // Last month = 1am first day of last month to 1am first day of this month (Eastern Time)
          const firstDayOfThisMonth = startOfMonth(easternNow);
          const lastMonth = new Date(firstDayOfThisMonth);
          lastMonth.setMonth(lastMonth.getMonth() - 1);
          const firstDayOfLastMonth = startOfMonth(lastMonth);
          
          // Start boundary: 1am first day of last month
          const startDate = new Date(firstDayOfLastMonth);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am first day of this month
          const firstDayOfThisMonthOneAM = new Date(firstDayOfThisMonth);
          firstDayOfThisMonthOneAM.setHours(1, 0, 0, 0);
          const endDate = new Date(firstDayOfThisMonthOneAM);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
        
        case 'custom':
          // Should only get here if custom range was selected without dates
          throw new Error('Start date and end date must be provided for custom date range');
          
        default: {
          // Default to today
          const today = startOfDay(easternNow);
          
          // Start boundary: 1am today
          const startDate = new Date(today);
          startDate.setHours(1, 0, 0, 0);
          easternStartDate = startDate;
          
          // End boundary: 12:59:59.999am tomorrow
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(1, 0, 0, 0);
          const endDate = new Date(tomorrow);
          endDate.setMilliseconds(-1); // 00:59:59.999
          easternEndDate = endDate;
          break;
        }
      }
      
      console.log('DIAGNOSTIC - Predefined date range with 1AM-1AM business day boundaries:', {
        dateRange,
        easternStartDate: formatInTimeZone(easternStartDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        easternEndDate: formatInTimeZone(easternEndDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
    }
    
    // Now convert Eastern Time dates directly to UTC format for database query
    // We need to use the dateString + offset approach to ensure proper conversion
    
    // Format dates with offset indicators for precise timezone conversion
    const eastStartISO = formatInTimeZone(easternStartDate, this.EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
    const eastEndISO = formatInTimeZone(easternEndDate, this.EASTERN_TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
    
    // Create UTC dates from these ISO strings (with offsets included)
    const utcStart = new Date(eastStartISO);
    const utcEnd = new Date(eastEndISO);
    
    // Special case for Feb 26 debugging
    if (isFeb26Request || 
        formatInTimeZone(easternStartDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd').includes('2025-02-26') || 
        formatInTimeZone(easternEndDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd').includes('2025-02-26')) {
      
      // If we're looking at Feb 26, analyze all transactions for this day
      console.log('DIAGNOSTIC - Analyzing Feb 26 transactions...');
      
      // Direct UTC times for Feb 26 business day (1am to 1am Eastern)
      const feb26UTCStart = new Date('2025-02-26T06:00:00.000Z'); // 1am Eastern (EST)
      const feb26UTCEnd = new Date('2025-02-27T05:59:59.999Z');   // 12:59:59 AM Eastern (EST) next day
      
      console.log('FEB 26 BUSINESS DAY (1AM-1AM EASTERN):', {
        start: feb26UTCStart.toISOString(),
        end: feb26UTCEnd.toISOString(),
        easternStart: formatInTimeZone(feb26UTCStart, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
        easternEnd: formatInTimeZone(feb26UTCEnd, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
      });
      
      // Run additional analysis
      setTimeout(async () => {
        try {
          // Get ALL transactions on Feb 26 (1am-1am Eastern Time) regardless of status
          const allDayTransactions = await db.select()
            .from(transactions)
            .where(
              and(
                gte(transactions.timestamp, new Date('2025-02-26T06:00:00.000Z')), // 1am Eastern
                lte(transactions.timestamp, new Date('2025-02-27T05:59:59.999Z'))  // 12:59:59AM Eastern next day
              )
            );
            
          console.log(`DIAGNOSTIC - Feb 26 total transactions: ${allDayTransactions.length}`);
          
          // Group by status
          const statusCounts: Record<string, number> = {};
          allDayTransactions.forEach(t => {
            statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
          });
          console.log('DIAGNOSTIC - Feb 26 status breakdown:', statusCounts);
          
          // Group by category
          const categoryCounts: Record<string, number> = {};
          allDayTransactions.forEach(t => {
            categoryCounts[t.categoryId] = (categoryCounts[t.categoryId] || 0) + 1;
          });
          console.log('DIAGNOSTIC - Feb 26 category breakdown:', categoryCounts);
          
          // Check active transactions
          const activeTransactions = allDayTransactions.filter(t => 
            t.status === 'completed' && 
            t.categoryId !== 'refund' && 
            t.amount > 0
          );
          console.log(`DIAGNOSTIC - Feb 26 active transactions: ${activeTransactions.length}`);
          
        } catch (err) {
          console.error('Error analyzing Feb 26 transactions:', err);
        }
      }, 1000); // Run this after 1 second to not block the main request
    }
    
    console.log('FINAL DATABASE QUERY RANGE (1AM-1AM BUSINESS DAY):', {
      utcStart: utcStart.toISOString(),
      utcEnd: utcEnd.toISOString(),
      easternStart: formatInTimeZone(easternStartDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'),
      easternEnd: formatInTimeZone(easternEndDate, this.EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz')
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