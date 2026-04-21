import { db } from './db';
import { sql, eq, and, desc } from 'drizzle-orm';
import { 
  users, transactions, giftCards, giftCardRedemptions, 
  orders, orderLineItems, orderModifiers, orderDiscounts, syncState,
  mcpQueryAudit,
  DateRange, TransactionStatus, Order, OrderLineItem, OrderModifier, OrderDiscount,
  InsertUser, User, InsertTransaction, Transaction,
  InsertGiftCard, GiftCard, InsertGiftCardRedemption, GiftCardRedemption,
  InsertOrder, InsertOrderLineItem, InsertOrderModifier, InsertOrderDiscount,
  OrderSummary, InsertSyncState, SyncState,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  InsertMcpQueryAudit
} from '@shared/schema';
import { getEasternDateRange, formatEasternDate, formatHour, EASTERN_TIMEZONE } from './dateUtils';
import { formatInTimeZone } from 'date-fns-tz';
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

  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users);
  }

  // Transaction methods
  async getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date, status?: TransactionStatus): Promise<Transaction[]> {
    // Get UTC date range for the requested period
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Format UTC dates correctly for database query
    const startUTC = start.toISOString();
    const endUTC = end.toISOString();
    
    // Query directly using UTC timestamps
    const filteredTransactions = await db.execute(sql`
      SELECT * 
      FROM transactions
      WHERE timestamp >= ${startUTC}::timestamp
        AND timestamp <= ${endUTC}::timestamp
        ${status ? sql` AND status = ${status}` : sql``}
      ORDER BY timestamp DESC
    `);
    
    // Map the raw results to Transaction objects
    return filteredTransactions.rows.map(row => ({
      id: Number(row.id),
      amount: Number(row.amount),
      status: row.status as TransactionStatus,
      categoryId: row.category_id as string,
      timestamp: new Date(row.timestamp as string),
      squareId: row.square_id as string,
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
      .set({ redeemedAmount: sql`"redeemedAmount" + ${amount}` })
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
    // Get UTC date range for the requested period
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Get completed transactions for the current period
    const currentTransactions = await this.getTransactions(dateRange, startDate, endDate, 'completed');
    
    // Calculate total revenue from transactions
    const totalRevenue = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
    
    // Get gift card sales for the period
    const giftCardSales = await this.getGiftCardSales(dateRange, startDate, endDate);
    
    // Get previous period for comparison - keep the same logic but with UTC dates
    let previousStart = new Date(start);
    let previousEnd = new Date(end);
    
    // Calculate previous period based on current date range
    if (dateRange === 'today') {
      previousStart.setDate(previousStart.getDate() - 1);
      previousEnd.setDate(previousEnd.getDate() - 1);
    } else if (dateRange === 'yesterday') {
      previousStart.setDate(previousStart.getDate() - 1);
      previousEnd.setDate(previousEnd.getDate() - 1);
    } else if (dateRange === 'yearToDate') {
      previousStart.setFullYear(previousStart.getFullYear() - 1);
      previousEnd.setFullYear(previousEnd.getFullYear() - 1);
    } else if (dateRange === 'thisMonth' || dateRange === 'lastMonth') {
      previousStart.setMonth(previousStart.getMonth() - 1);
      previousEnd.setMonth(previousEnd.getMonth() - 1);
    } else {
      // For last7days, last30days, and custom, just shift by the same duration
      const currentDuration = end.getTime() - start.getTime();
      previousStart = new Date(start.getTime() - currentDuration);
      previousEnd = new Date(start.getTime() - 1); // End just before current period starts
    }
    
    // Get previous period transactions using UTC timestamps
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
    
    // Calculate orders metrics - this stays the same
    const totalOrders = currentTransactions.length;
    const previousOrders = previousTransactions.length;
    const ordersChange = previousOrders === 0 ? 0 : (totalOrders - previousOrders) / previousOrders;
    
    // Calculate average order value
    const averageOrder = totalOrders === 0 ? 0 : totalRevenue / totalOrders;
    const previousAverage = previousOrders === 0 ? 0 : previousRevenue / previousOrders;
    const averageOrderChange = previousAverage === 0 ? 0 : (averageOrder - previousAverage) / previousAverage;
    
    return {
      totalRevenue,
      grossPayments: totalRevenue,
      refunds: 0,
      returns: 0,
      giftCardRedemptions: 0,
      depositClearings: 0,
      partywirksDeposits: 0,
      tripleseatDeposits: 0,
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
    // Get UTC date range for the requested period
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Format UTC dates for database queries
    const startUTC = start.toISOString();
    const endUTC = end.toISOString();
    
    // Query to get gift cards sold directly from gift_cards table using UTC timestamps
    // Always use activation_amount as the source of truth for gift card sales
    const soldResult = await db.execute(sql`
      SELECT 
        COUNT(*) as sold_count,
        SUM(activation_amount) as sold_amount
      FROM 
        gift_cards
      WHERE 
        purchase_date >= ${startUTC}::timestamp
        AND purchase_date <= ${endUTC}::timestamp
    `);
    
    // Query to get gift card redemptions using UTC timestamps
    const redeemedResult = await db.execute(sql`
      SELECT 
        COUNT(*) as redeemed_count,
        COALESCE(SUM(amount), 0) as redeemed_amount
      FROM 
        gift_card_redemptions
      WHERE 
        timestamp >= ${startUTC}::timestamp
        AND timestamp <= ${endUTC}::timestamp
    `);
    
    // Extract the results
    const soldCount = Number(soldResult.rows[0]?.sold_count) || 0;
    const soldAmount = Number(soldResult.rows[0]?.sold_amount) || 0;
    const redeemedCount = Number(redeemedResult.rows[0]?.redeemed_count) || 0;
    const redeemedAmount = Number(redeemedResult.rows[0]?.redeemed_amount) || 0;
    
    // Calculate average value
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    
    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue,
      outstandingBalance: soldAmount - redeemedAmount
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
    // Get UTC date range for the requested period
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    
    // Format UTC dates correctly for database query
    // We're using the UTC timestamp directly
    const startUTC = start.toISOString();
    const endUTC = end.toISOString();

    // Query gift_cards table using activation_amount as the source of truth
    // This is the most accurate representation of gift card sales
    const giftCardsResult = await db.execute(sql`
      SELECT 
        SUM(activation_amount) as total_activation,
        COUNT(*) as card_count
      FROM 
        gift_cards
      WHERE 
        purchase_date >= ${startUTC}::timestamp
        AND purchase_date <= ${endUTC}::timestamp
    `);

    const giftCardSales = Number(giftCardsResult.rows[0]?.total_activation) || 0;

    // Return just the gift card sales from activation_amount
    // This eliminates potential double-counting issues
    return giftCardSales;
  }

  // MCP read-query audit log
  async recordMcpQueryAudit(entry: InsertMcpQueryAudit): Promise<void> {
    await db.insert(mcpQueryAudit).values(entry);
  }

  async pruneMcpQueryAudit(maxAgeDays: number): Promise<number> {
    const result = await db.execute(sql`
      DELETE FROM mcp_query_audit
      WHERE created_at < NOW() - (${maxAgeDays} || ' days')::interval
    `);
    return result.rowCount ?? 0;
  }
}

export const pgStorage = new PgStorage();