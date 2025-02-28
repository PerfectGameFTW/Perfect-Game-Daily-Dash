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
import { format } from "date-fns";
import { EASTERN_TIMEZONE } from "./dateUtils";
import { IStorage } from "./storage";
import pg from "pg";
const { Pool } = pg;
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, sql } from "drizzle-orm";

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

  // Transaction methods using Eastern Time views
  async getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date, status: TransactionStatus = 'completed'): Promise<Transaction[]> {
    console.log('DIAGNOSTIC - getTransactions start', { dateRange, startDate, endDate, status });

    // Convert input dates to Eastern Time for consistent comparison
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : start;

    // Format dates for the query
    const startStr = format(start, 'yyyy-MM-dd');
    const endStr = format(end, 'yyyy-MM-dd');

    console.log('Using date range:', {
      startStr,
      endStr,
      timezone: EASTERN_TIMEZONE
    });

    // Query using the Eastern Time view
    const result = await db.execute<Transaction>(sql`
      SELECT 
        t.id,
        t.square_id,
        t.amount,
        t.category_id,
        t.status,
        t.timestamp,  -- Keep original UTC timestamp in the result
        t.square_data
      FROM transactions_et te
      JOIN transactions t ON t.id = te.id
      WHERE DATE(te.timestamp_et) >= ${startStr}::date
        AND DATE(te.timestamp_et) <= ${endStr}::date
        AND t.status = ${status}
      ORDER BY te.timestamp_et DESC
    `);

    console.log(`DIAGNOSTIC - getTransactions result length: ${result.rows.length}`);
    return result.rows;
  }

  // Other transaction methods
  async getTransactionById(id: number): Promise<Transaction | undefined> {
    const result = await db.select().from(transactions).where(eq(transactions.id, id));
    return result[0];
  }

  async getTransactionBySquareId(squareId: string): Promise<Transaction | undefined> {
    const result = await db.select().from(transactions).where(eq(transactions.squareId, squareId));
    return result[0];
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    // Note: insertTransaction.timestamp should already be in UTC
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
    // Note: insertGiftCard.purchaseDate should already be in UTC
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
    // Note: insertRedemption.timestamp should already be in UTC
    const result = await db.insert(giftCardRedemptions).values(insertRedemption).returning();
    await this.updateGiftCardRedemption(insertRedemption.giftCardId, insertRedemption.amount);
    return result[0];
  }

  async getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]> {
    return await db.select()
      .from(giftCardRedemptions)
      .where(eq(giftCardRedemptions.giftCardId, giftCardId))
      .orderBy(sql`${giftCardRedemptions.timestamp} DESC`);
  }

  // Dashboard summary methods using Eastern Time views
  async getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary> {
    // Convert input dates to Eastern Time for consistent comparison
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : start;

    // Format dates for the query
    const startStr = format(start, 'yyyy-MM-dd');
    const endStr = format(end, 'yyyy-MM-dd');

    // Calculate previous period dates
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - (end.getDate() - start.getDate() + 1));
    const prevEnd = new Date(end);
    prevEnd.setDate(prevEnd.getDate() - (end.getDate() - start.getDate() + 1));

    const prevStartStr = format(prevStart, 'yyyy-MM-dd');
    const prevEndStr = format(prevEnd, 'yyyy-MM-dd');

    // Query using Eastern Time views for current period
    const currentTransactions = await db.execute(sql`
      SELECT * FROM transactions_et
      WHERE DATE(timestamp_et) >= ${startStr}::date
        AND DATE(timestamp_et) <= ${endStr}::date
        AND status = 'completed'
    `);

    // Query using Eastern Time views for previous period
    const prevTransactions = await db.execute(sql`
      SELECT * FROM transactions_et
      WHERE DATE(timestamp_et) >= ${prevStartStr}::date
        AND DATE(timestamp_et) <= ${prevEndStr}::date
        AND status = 'completed'
    `);

    // Calculate metrics
    const totalRevenue = currentTransactions.rows.reduce((sum, t: any) => sum + t.amount, 0);
    const totalOrders = currentTransactions.rows.length;
    const averageOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const prevTotalRevenue = prevTransactions.rows.reduce((sum, t: any) => sum + t.amount, 0);
    const prevTotalOrders = prevTransactions.rows.length;
    const prevAverageOrder = prevTotalOrders > 0 ? prevTotalRevenue / prevTotalOrders : 0;

    // Calculate gift card metrics
    const giftCardSales = currentTransactions.rows
      .filter((t: any) => t.category_id === 'giftCard')
      .reduce((sum, t: any) => sum + t.amount, 0);

    const prevGiftCardSales = prevTransactions.rows
      .filter((t: any) => t.category_id === 'giftCard')
      .reduce((sum, t: any) => sum + t.amount, 0);

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
    
    // Use the imported EASTERN_TIMEZONE constant
    
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
      const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);
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
    // Convert input dates to Eastern Time for consistent comparison
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : start;

    // Format dates for the query
    const startStr = format(start, 'yyyy-MM-dd');
    const endStr = format(end, 'yyyy-MM-dd');

    // Query gift card sales using Eastern Time view
    const giftCardSales = await db.execute(sql`
      SELECT * FROM transactions_et
      WHERE DATE(timestamp_et) >= ${startStr}::date
        AND DATE(timestamp_et) <= ${endStr}::date
        AND category_id = 'giftCard'
        AND status = 'completed'
    `);

    // Query gift card redemptions using Eastern Time view
    const redemptions = await db.execute(sql`
      SELECT * FROM gift_card_redemptions_et
      WHERE DATE(timestamp_et) >= ${startStr}::date
        AND DATE(timestamp_et) <= ${endStr}::date
    `);

    // Calculate summary metrics
    const soldCount = giftCardSales.rows.length;
    const soldAmount = giftCardSales.rows.reduce((sum, t: any) => sum + t.amount, 0);
    const redeemedCount = redemptions.rows.length;
    const redeemedAmount = redemptions.rows.reduce((sum, r: any) => sum + r.amount, 0);
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;

    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue
    };
  }
  

  private getDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
    // Use the imported getEasternDateRange function
    return getEasternDateRange(dateRange, startDate, endDate);
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