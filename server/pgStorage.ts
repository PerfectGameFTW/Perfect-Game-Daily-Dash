import { db } from './db';
import { sql, eq, and, desc } from 'drizzle-orm';
import { 
  users, transactions, giftCards, giftCardRedemptions, 
  orders, orderLineItems, orderModifiers, orderDiscounts, syncState,
  DateRange, TransactionStatus, Order, OrderLineItem, OrderModifier, OrderDiscount,
  InsertUser, User, InsertTransaction, Transaction,
  InsertGiftCard, GiftCard, InsertGiftCardRedemption, GiftCardRedemption,
  InsertOrder, InsertOrderLineItem, InsertOrderModifier, InsertOrderDiscount,
  OrderSummary, InsertSyncState, SyncState,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary
} from '@shared/schema';
import { getEasternDateRange, formatEasternDate, formatHour } from './dateUtils';
// Note: validateInsertData function needs to be implemented separately
// We're just doing a simple validation check in createOrder for now
import { InvalidOrderDataError, OrderNotFoundError } from './errors';

// Import IStorage interface from './storage'
import { IStorage } from './storage';

class PgStorage implements IStorage {
  // User methods
  async getUser(id: number): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(user: InsertUser): Promise<User> {
    const result = await db.insert(users).values(user).returning();
    return result[0];
  }

  // Transaction methods
  async getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date, status?: TransactionStatus): Promise<Transaction[]> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const startStr = formatEasternDate(start);
    const endStr = formatEasternDate(end);
    
    console.log(`Filtering transactions for date range: ${startStr} to ${endStr}`);
    
    // Use a SQL query to properly filter by Eastern timezone dates
    const filteredTransactions = await db.execute(sql`
      WITH transactions_et AS (
        SELECT *, timestamp AT TIME ZONE 'America/New_York' as timestamp_et
        FROM transactions
      )
      SELECT * 
      FROM transactions_et
      WHERE DATE(timestamp_et) >= ${startStr}::date
        AND DATE(timestamp_et) <= ${endStr}::date
        ${status ? sql` AND status = ${status}` : sql``}
      ORDER BY timestamp DESC
    `);
    
    // Map the raw results to Transaction objects
    return filteredTransactions.rows.map(row => ({
      id: Number(row.id),
      amount: Number(row.amount),
      status: row.status as TransactionStatus,
      category: row.category,
      timestamp: new Date(row.timestamp),
      squareId: row.square_id,
      orderId: row.order_id ? Number(row.order_id) : null,
      squareData: row.square_data
    }));
  }

  async getTransactionById(id: number): Promise<Transaction | undefined> {
    const result = await db.select().from(transactions).where(eq(transactions.id, id));
    return result[0];
  }

  async getTransactionBySquareId(squareId: string): Promise<Transaction | undefined> {
    const result = await db.select().from(transactions).where(eq(transactions.squareId, squareId));
    return result[0];
  }

  async createTransaction(transaction: InsertTransaction): Promise<Transaction> {
    const result = await db.insert(transactions).values(transaction).returning();
    return result[0];
  }

  // Gift card methods
  async getGiftCards(): Promise<GiftCard[]> {
    return await db.select().from(giftCards).orderBy(desc(giftCards.purchaseDate));
  }

  async getGiftCardById(id: number): Promise<GiftCard | undefined> {
    const result = await db.select().from(giftCards).where(eq(giftCards.id, id));
    return result[0];
  }

  async getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined> {
    const result = await db.select().from(giftCards).where(eq(giftCards.squareId, squareId));
    return result[0];
  }

  async createGiftCard(giftCard: InsertGiftCard): Promise<GiftCard> {
    const result = await db.insert(giftCards).values(giftCard).returning();
    return result[0];
  }

  async updateGiftCardRedemption(id: number, amount: number): Promise<GiftCard> {
    const result = await db
      .update(giftCards)
      .set({ redeemedAmount: sql`redeemed_amount + ${amount}` })
      .where(eq(giftCards.id, id))
      .returning();
    return result[0];
  }

  // Gift card redemption methods
  async createGiftCardRedemption(redemption: InsertGiftCardRedemption): Promise<GiftCardRedemption> {
    const result = await db.insert(giftCardRedemptions).values(redemption).returning();
    return result[0];
  }

  async getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]> {
    return await db.select().from(giftCardRedemptions).where(eq(giftCardRedemptions.giftCardId, giftCardId));
  }

  // Dashboard summary methods
  async getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const startStr = formatEasternDate(start);
    const endStr = formatEasternDate(end);
    
    // Get completed transactions for the current period
    const currentTransactions = await this.getTransactions(dateRange, startDate, endDate, 'completed');
    
    // Calculate total revenue from transactions
    const totalRevenue = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
    
    // Get gift card sales for the period
    const giftCardSales = await this.getGiftCardSales(dateRange, startDate, endDate);
    
    // Get previous period for comparison
    let previousStart = new Date(start);
    let previousEnd = new Date(end);
    
    // Calculate previous period based on current date range
    if (dateRange === 'today') {
      previousStart.setDate(previousStart.getDate() - 1);
      previousEnd.setDate(previousEnd.getDate() - 1);
    } else if (dateRange === 'yesterday') {
      previousStart.setDate(previousStart.getDate() - 1);
      previousEnd.setDate(previousEnd.getDate() - 1);
    } else if (dateRange === 'thisMonth' || dateRange === 'lastMonth') {
      previousStart.setMonth(previousStart.getMonth() - 1);
      previousEnd.setMonth(previousEnd.getMonth() - 1);
    } else {
      // For last7days, last30days, and custom, just shift by the same duration
      const currentDuration = end.getTime() - start.getTime();
      previousStart = new Date(start.getTime() - currentDuration);
      previousEnd = new Date(start.getTime() - 1); // End just before current period starts
    }
    
    // Get previous period transactions
    const previousTransactions = await this.getTransactions(
      'custom', 
      previousStart, 
      previousEnd, 
      'completed'
    );
    
    // Calculate previous period metrics
    const previousRevenue = previousTransactions.reduce((sum, t) => sum + t.amount, 0);
    const previousGiftCardSales = await this.getGiftCardSales('custom', previousStart, previousEnd);
    
    // Calculate changes
    const revenueChange = previousRevenue === 0 ? 0 : (totalRevenue - previousRevenue) / previousRevenue;
    const giftCardSalesChange = previousGiftCardSales === 0 ? 0 : (giftCardSales - previousGiftCardSales) / previousGiftCardSales;
    
    // Calculate orders metrics (placeholder implementation)
    // In a real implementation, we would count actual orders
    const totalOrders = currentTransactions.length;
    const previousOrders = previousTransactions.length;
    const ordersChange = previousOrders === 0 ? 0 : (totalOrders - previousOrders) / previousOrders;
    
    // Calculate average order value
    const averageOrder = totalOrders === 0 ? 0 : totalRevenue / totalOrders;
    const previousAverage = previousOrders === 0 ? 0 : previousRevenue / previousOrders;
    const averageOrderChange = previousAverage === 0 ? 0 : (averageOrder - previousAverage) / previousAverage;
    
    return {
      totalRevenue,
      revenueChange,
      totalOrders,
      ordersChange,
      averageOrder,
      averageOrderChange,
      giftCardSales,
      giftCardSalesChange,
      date: new Date().toLocaleDateString()
    };
  }

  async getCategoryRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<CategoryRevenue[]> {
    // Simplified implementation for now
    return [];
  }

  async getHourlyRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<HourlyRevenue[]> {
    // Simplified implementation for now
    return Array.from({ length: 24 }, (_, i) => ({
      hour: formatHour(i),
      amount: 0
    }));
  }

  async getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const startStr = formatEasternDate(start);
    const endStr = formatEasternDate(end);
    
    console.log('Getting gift card summary for range:', { startStr, endStr });
    
    // Query to get gift cards sold in the date range using Eastern Time
    const soldResult = await db.execute(sql`
      SELECT 
        COUNT(*) as sold_count,
        COALESCE(SUM(amount + redeemed_amount), 0) as sold_amount
      FROM 
        gift_cards_et
      WHERE 
        DATE(purchase_date_et) >= ${startStr}::date
        AND DATE(purchase_date_et) <= ${endStr}::date
    `);
    
    // Query to get gift card redemptions in the date range using Eastern Time
    const redeemedResult = await db.execute(sql`
      SELECT 
        COUNT(*) as redeemed_count,
        COALESCE(SUM(amount), 0) as redeemed_amount
      FROM 
        gift_card_redemptions_et
      WHERE 
        DATE(timestamp_et) >= ${startStr}::date
        AND DATE(timestamp_et) <= ${endStr}::date
    `);
    
    // Extract the results
    const soldCount = Number(soldResult.rows[0]?.sold_count) || 0;
    const soldAmount = Number(soldResult.rows[0]?.sold_amount) || 0;
    const redeemedCount = Number(redeemedResult.rows[0]?.redeemed_count) || 0;
    const redeemedAmount = Number(redeemedResult.rows[0]?.redeemed_amount) || 0;
    
    // Calculate average value
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    
    console.log('Gift card summary calculated from database:', {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue
    });
    
    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue
    };
  }

  // Sync state management methods
  async getSyncState(syncType: string): Promise<SyncState | undefined> {
    const result = await db.select().from(syncState).where(eq(syncState.syncType, syncType));
    return result[0];
  }

  async createSyncState(state: InsertSyncState): Promise<SyncState> {
    const result = await db.insert(syncState).values(state).returning();
    return result[0];
  }

  async updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState> {
    const result = await db.update(syncState).set(updates).where(eq(syncState.id, id)).returning();
    return result[0];
  }

  async getSyncProgress(): Promise<{ payments: number; giftCards: number }> {
    const paymentsState = await this.getSyncState('payments');
    const giftCardsState = await this.getSyncState('gift_cards');

    // Use processedCount as progress indicator
    return {
      payments: paymentsState?.processedCount || 0,
      giftCards: giftCardsState?.processedCount || 0
    };
  }

  // Order methods
  async getOrder(id: number): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.id, id));
    if (result.length === 0) {
      throw new OrderNotFoundError(id);
    }
    return result[0];
  }

  async getOrderBySquareId(squareId: string): Promise<Order | undefined> {
    const result = await db.select().from(orders).where(eq(orders.squareId, squareId));
    return result[0];
  }

  async createOrder(order: InsertOrder): Promise<Order> {
    // Simplified validation - just check that required fields are present
    if (!order.squareId || !order.status || !order.createdAt) {
      throw new InvalidOrderDataError(`Invalid order data: Missing required fields`);
    }

    const result = await db.insert(orders).values(order).returning();
    return result[0];
  }

  async getOrderItems(orderId: number): Promise<OrderLineItem[]> {
    return await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  }

  async createOrderItem(item: InsertOrderLineItem): Promise<OrderLineItem> {
    const result = await db.insert(orderLineItems).values(item).returning();
    return result[0];
  }

  async getOrderModifiers(lineItemId: number): Promise<OrderModifier[]> {
    return await db.select().from(orderModifiers).where(eq(orderModifiers.lineItemId, lineItemId));
  }

  async createOrderModifier(modifier: InsertOrderModifier): Promise<OrderModifier> {
    const result = await db.insert(orderModifiers).values(modifier).returning();
    return result[0];
  }

  async getOrderDiscounts(orderId: number): Promise<OrderDiscount[]> {
    return await db.select().from(orderDiscounts).where(eq(orderDiscounts.orderId, orderId));
  }

  async createOrderDiscount(discount: InsertOrderDiscount): Promise<OrderDiscount> {
    const result = await db.insert(orderDiscounts).values(discount).returning();
    return result[0];
  }

  async getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary> {
    // Simplified implementation for now
    return {
      totalOrders: 0,
      totalRevenue: 0,
      averageOrderValue: 0,
      itemsSold: 0,
      topSellingItems: [],
      discountTotal: 0,
      taxTotal: 0
    };
  }

  async getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number> {
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const startStr = formatInTimeZone(start, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    const endStr = formatInTimeZone(end, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    console.log('Getting gift card sales for range (with timestamp precision):', { 
      startStr, 
      endStr,
      startDate: start.toISOString(),
      endDate: end.toISOString()
    });

    // Use the gift_cards_et view which already has the Eastern Time purchase_date_et field
    // Use TIMESTAMP comparisons instead of DATE to properly handle timezone boundaries
    const result = await db.execute(sql`
      SELECT 
        -- Calculate total activation amount (original value)
        -- This is always current balance + redeemed_amount (activation value)
        COALESCE(SUM(amount + redeemed_amount), 0) as total_activation,
        COUNT(*) as card_count
      FROM 
        gift_cards_et
      WHERE 
        purchase_date_et >= ${start}::timestamptz
        AND purchase_date_et <= ${end}::timestamptz
    `);

    const totalSales = Number(result.rows[0]?.total_activation) || 0;
    const cardCount = Number(result.rows[0]?.card_count) || 0;
    
    console.log('Gift card sales (activations only) calculated from database:', {
      totalSales,
      cardCount,
      timeRange: `${startStr} to ${endStr}`
    });
    return totalSales;
  }
}

export const pgStorage = new PgStorage();