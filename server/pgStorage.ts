import { 
  Transaction, InsertTransaction, 
  GiftCard, InsertGiftCard, 
  GiftCardRedemption, InsertGiftCardRedemption,
  User, InsertUser,
  SyncState, InsertSyncState,
  Order, InsertOrder,
  OrderLineItem, InsertOrderLineItem,
  OrderModifier, InsertOrderModifier,
  OrderDiscount, InsertOrderDiscount,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary, OrderSummary,
  DateRange, TransactionStatus,
  transactions, giftCards, giftCardRedemptions, users, syncState,
  orders, orderLineItems, orderModifiers, orderDiscounts
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

    // Query using the Eastern Time view with more detailed SQL 
    const result = await db.execute(sql`
      WITH daily_transactions AS (
        SELECT t.*
        FROM transactions_et te
        JOIN transactions t ON t.id = te.id
        WHERE DATE(te.timestamp_et) >= ${startStr}::date
          AND DATE(te.timestamp_et) <= ${endStr}::date
          AND t.status = ${status}
      )
      SELECT 
        dt.*,
        COUNT(*) OVER() as total_count,
        SUM(dt.amount) OVER() as total_amount
      FROM daily_transactions dt
      ORDER BY dt.timestamp DESC
    `);

    console.log(`DIAGNOSTIC - getTransactions result details:`, {
      rowCount: result.rows.length,
      sampleTimestamp: result.rows[0]?.timestamp,
      totalAmount: result.rows[0]?.total_amount,
      dateRange: { startStr, endStr }
    });

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
    console.log('DIAGNOSTIC - getDailySummary start', { dateRange, startDate, endDate });

    // Convert input dates to Eastern Time for consistent comparison
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : start;

    // Format dates for the query
    const startStr = format(start, 'yyyy-MM-dd');
    const endStr = format(end, 'yyyy-MM-dd');

    console.log('Using date range for daily summary:', {
      startStr,
      endStr,
      timezone: EASTERN_TIMEZONE
    });

    // Query using Eastern Time views for current period with more detailed calculations
    const currentTransactions = await db.execute(sql`
      WITH daily_metrics AS (
        SELECT 
          DATE(te.timestamp_et) as date,
          COUNT(*) as order_count,
          SUM(t.amount) as daily_total,
          SUM(CASE WHEN t.category_id = 'giftCard' THEN t.amount ELSE 0 END) as gift_card_total
        FROM transactions_et te
        JOIN transactions t ON t.id = te.id
        WHERE DATE(te.timestamp_et) >= ${startStr}::date
          AND DATE(te.timestamp_et) <= ${endStr}::date
          AND t.status = 'completed'
        GROUP BY DATE(te.timestamp_et)
      )
      SELECT 
        SUM(daily_total) as total_revenue,
        SUM(order_count) as total_orders,
        SUM(gift_card_total) as gift_card_sales,
        COUNT(DISTINCT date) as days_count
      FROM daily_metrics
    `);

    console.log('DIAGNOSTIC - Daily summary query results:', {
      totalRevenue: currentTransactions.rows[0]?.total_revenue,
      totalOrders: currentTransactions.rows[0]?.total_orders,
      giftCardSales: currentTransactions.rows[0]?.gift_card_sales,
      daysCount: currentTransactions.rows[0]?.days_count
    });

    // Calculate previous period dates
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - (end.getDate() - start.getDate() + 1));
    const prevEnd = new Date(end);
    prevEnd.setDate(prevEnd.getDate() - (end.getDate() - start.getDate() + 1));

    const prevStartStr = format(prevStart, 'yyyy-MM-dd');
    const prevEndStr = format(prevEnd, 'yyyy-MM-dd');

    // Query using Eastern Time views for previous period
    const prevTransactions = await db.execute(sql`
      WITH daily_metrics AS (
        SELECT 
          DATE(te.timestamp_et) as date,
          COUNT(*) as order_count,
          SUM(t.amount) as daily_total,
          SUM(CASE WHEN t.category_id = 'giftCard' THEN t.amount ELSE 0 END) as gift_card_total
        FROM transactions_et te
        JOIN transactions t ON t.id = te.id
        WHERE DATE(te.timestamp_et) >= ${prevStartStr}::date
          AND DATE(te.timestamp_et) <= ${prevEndStr}::date
          AND t.status = 'completed'
        GROUP BY DATE(te.timestamp_et)
      )
      SELECT 
        SUM(daily_total) as total_revenue,
        SUM(order_count) as total_orders,
        SUM(gift_card_total) as gift_card_sales,
        COUNT(DISTINCT date) as days_count
      FROM daily_metrics
    `);

    // Calculate metrics
    const totalRevenue = currentTransactions.rows[0]?.total_revenue || 0;
    const totalOrders = currentTransactions.rows[0]?.total_orders || 0;
    const averageOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const prevTotalRevenue = prevTransactions.rows[0]?.total_revenue || 0;
    const prevTotalOrders = prevTransactions.rows[0]?.total_orders || 0;
    const prevAverageOrder = prevTotalOrders > 0 ? prevTotalRevenue / prevTotalOrders : 0;

    // Calculate gift card metrics
    const giftCardSales = currentTransactions.rows[0]?.gift_card_sales || 0;
    const prevGiftCardSales = prevTransactions.rows[0]?.gift_card_sales || 0;

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

  // Order methods
  async getOrder(id: number): Promise<Order | undefined> {
    try {
      console.log(`Fetching order with ID: ${id}`);
      const result = await db.select().from(orders).where(eq(orders.id, id));
      if (!result.length) {
        throw new OrderNotFoundError(id);
      }
      return result[0];
    } catch (error) {
      if (error instanceof OrderNotFoundError) {
        throw error;
      }
      console.error(`Error fetching order ${id}:`, error);
      throw new OrderError('Failed to fetch order', 'DB_ERROR', error);
    }
  }

  async getOrderBySquareId(squareId: string): Promise<Order | undefined> {
    try {
      console.log(`Fetching order with Square ID: ${squareId}`);
      const result = await db.select().from(orders).where(eq(orders.squareId, squareId));
      if (!result.length) {
        throw new OrderNotFoundError(squareId);
      }
      return result[0];
    } catch (error) {
      if (error instanceof OrderNotFoundError) {
        throw error;
      }
      console.error(`Error fetching order with Square ID ${squareId}:`, error);
      throw new OrderError('Failed to fetch order by Square ID', 'DB_ERROR', error);
    }
  }

  async createOrder(insertOrder: InsertOrder): Promise<Order> {
    try {
      if (!insertOrder.squareId || !insertOrder.status) {
        throw new InvalidOrderDataError('Missing required order fields');
      }

      // No need to manually convert timestamps - PostgreSQL handles it
      console.log(`Creating new order with Square ID: ${insertOrder.squareId}`);
      const result = await db.insert(orders).values(insertOrder).returning();

      if (!result.length) {
        throw new OrderProcessingError('Order creation failed');
      }

      console.log(`Successfully created order: ${result[0].id}`);
      return result[0];
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      console.error('Error creating order:', error);
      throw new OrderProcessingError('Failed to create order', error);
    }
  }

  async getOrderItems(orderId: number): Promise<OrderLineItem[]> {
    try {
      console.log(`Fetching line items for order: ${orderId}`);
      const items = await db.select()
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, orderId));

      console.log(`Found ${items.length} line items for order ${orderId}`);
      return items;
    } catch (error) {
      console.error(`Error fetching line items for order ${orderId}:`, error);
      throw new OrderError('Failed to fetch order items', 'DB_ERROR', error);
    }
  }

  async createOrderItem(insertItem: InsertOrderLineItem): Promise<OrderLineItem> {
    try {
      if (!insertItem.orderId || !insertItem.name) {
        throw new InvalidOrderDataError('Missing required line item fields');
      }

      console.log(`Creating line item for order: ${insertItem.orderId}`);
      const result = await db.insert(orderLineItems).values(insertItem).returning();

      if (!result.length) {
        throw new OrderProcessingError('Line item creation failed');
      }

      console.log(`Successfully created line item: ${result[0].id}`);
      return result[0];
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      console.error('Error creating line item:', error);
      throw new OrderProcessingError('Failed to create line item', error);
    }
  }

  async getOrderModifiers(lineItemId: number): Promise<OrderModifier[]> {
    try {
      console.log(`Fetching modifiers for line item: ${lineItemId}`);
      const modifiers = await db.select()
        .from(orderModifiers)
        .where(eq(orderModifiers.lineItemId, lineItemId));

      console.log(`Found ${modifiers.length} modifiers for line item ${lineItemId}`);
      return modifiers;
    } catch (error) {
      console.error(`Error fetching modifiers for line item ${lineItemId}:`, error);
      throw new OrderError('Failed to fetch modifiers', 'DB_ERROR', error);
    }
  }

  async createOrderModifier(insertModifier: InsertOrderModifier): Promise<OrderModifier> {
    try {
      if (!insertModifier.lineItemId || !insertModifier.name) {
        throw new InvalidOrderDataError('Missing required modifier fields');
      }

      console.log(`Creating modifier for line item: ${insertModifier.lineItemId}`);
      const result = await db.insert(orderModifiers).values(insertModifier).returning();

      if (!result.length) {
        throw new OrderProcessingError('Modifier creation failed');
      }

      console.log(`Successfully created modifier: ${result[0].id}`);
      return result[0];
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      console.error('Error creating modifier:', error);
      throw new OrderProcessingError('Failed to create modifier', error);
    }
  }

  async getOrderDiscounts(orderId: number): Promise<OrderDiscount[]> {
    try {
      console.log(`Fetching discounts for order: ${orderId}`);
      const discounts = await db.select()
        .from(orderDiscounts)
        .where(eq(orderDiscounts.orderId, orderId));

      console.log(`Found ${discounts.length} discounts for order ${orderId}`);
      return discounts;
    } catch (error) {
      console.error(`Error fetching discounts for order ${orderId}:`, error);
      throw new OrderError('Failed to fetch discounts', 'DB_ERROR', error);
    }
  }

  async createOrderDiscount(insertDiscount: InsertOrderDiscount): Promise<OrderDiscount> {
    try {
      if (!insertDiscount.orderId || !insertDiscount.name || !insertDiscount.type) {
        throw new InvalidOrderDataError('Missing required discount fields');
      }

      console.log(`Creating discount for order: ${insertDiscount.orderId}`);
      const result = await db.insert(orderDiscounts).values(insertDiscount).returning();

      if (!result.length) {
        throw new OrderProcessingError('Discount creation failed');
      }

      console.log(`Successfully created discount: ${result[0].id}`);
      return result[0];
    } catch (error) {
      if (error instanceof OrderError) {
        throw error;
      }
      console.error('Error creating discount:', error);
      throw new OrderProcessingError('Failed to create discount', error);
    }
  }

  async getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary> {
    const start = startDate ? new Date(startDate) : new Date();
    const end = endDate ? new Date(endDate) : start;

    // Format dates for the query - will be interpreted in Eastern Time
    const startStr = format(start, 'yyyy-MM-dd');
    const endStr = format(end, 'yyyy-MM-dd');

    // Use orders_et view for Eastern Time-based reporting
    const ordersResult = await db.execute(sql`
      WITH order_metrics AS (
        SELECT 
          o.id as order_id,
          o.total_money,
          li.name as item_name,
          li.quantity,
          li.total_money as item_revenue
        FROM orders_et o
        LEFT JOIN order_line_items li ON li.order_id = o.id
        WHERE DATE(o.created_at_et) >= ${startStr}::date
          AND DATE(o.created_at_et) <= ${endStr}::date
          AND o.status = 'COMPLETED'
      ),
      top_items AS (
        SELECT 
          item_name,
          SUM(quantity) as total_quantity,
          SUM(item_revenue) as total_revenue
        FROM order_metrics
        WHERE item_name IS NOT NULL
        GROUP BY item_name
        ORDER BY total_revenue DESC
        LIMIT 5
      )
      SELECT 
        COUNT(DISTINCT order_id) as total_orders,
        SUM(total_money) as total_revenue,
        SUM(quantity) as total_items,
        ARRAY_AGG(ROW(item_name, total_quantity, total_revenue)::text)
          FILTER (WHERE item_name IS NOT NULL) as top_items
      FROM order_metrics
      CROSS JOIN top_items;
    `);

    // Calculate total discounts and taxes using Eastern Time view
    const totalsResult = await db.execute(sql`
      SELECT 
        SUM(total_tax) as tax_total,
        SUM(total_discount) as discount_total
      FROM orders_et
      WHERE DATE(created_at_et) >= ${startStr}::date
        AND DATE(created_at_et) <= ${endStr}::date
        AND status = 'COMPLETED';
    `);

    const { rows: [orderMetrics] } = ordersResult;
    const { rows: [orderTotals] } = totalsResult;

    // Parse top selling items from the array
    const topSellingItems = (orderMetrics.top_items || []).map((item: string) => {
      const [name, quantity, revenue] = item
        .replace(/[()]/g, '')
        .split(',')
        .map((s, i) => i === 0 ? s : Number(s));
      return { name, quantity, revenue };
    });

    return {
      totalOrders: Number(orderMetrics.total_orders) || 0,
      totalRevenue: Number(orderMetrics.total_revenue) || 0,
      averageOrderValue: orderMetrics.total_orders > 0 
        ? Number(orderMetrics.total_revenue) / Number(orderMetrics.total_orders) 
        : 0,
      itemsSold: Number(orderMetrics.total_items) || 0,
      topSellingItems,
      discountTotal: Number(orderTotals.discount_total) || 0,
      taxTotal: Number(orderTotals.tax_total) || 0
    };
  }
}

export const pgStorage = new PgStorage();

// Placeholder functions - replace with actual implementations
const getEasternDateRange = (dateRange: DateRange, startDate?: Date, endDate?: Date) => ({start: new Date(), end: new Date()});
const toZonedTime = (date: Date, timezone: string) => new Date();

// Assume these error classes are defined elsewhere and imported.  Necessary for compilation.
class OrderError extends Error {
    constructor(message: string, code: string, cause?: Error) {
        super(message);
        this.name = 'OrderError';
        this.code = code;
        this.cause = cause;
    }
    code: string;
    cause?: Error;
}

class OrderNotFoundError extends OrderError {
    constructor(orderId: number | string) {
        super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND');
    }
}

class InvalidOrderDataError extends OrderError {
    constructor(message: string) {
        super(message, 'INVALID_ORDER_DATA');
    }
}

class OrderProcessingError extends OrderError {
    constructor(message: string, cause?: Error) {
        super(message, 'ORDER_PROCESSING_ERROR', cause);
    }
}