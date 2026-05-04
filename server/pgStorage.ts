import { db } from './db';
import { sql, eq, and, desc, inArray } from 'drizzle-orm';
import { 
  users, transactions, giftCards, giftCardRedemptions, 
  orders, orderLineItems, orderModifiers, orderDiscounts, syncState,
  mcpQueryAudit, appSettings, syncAudit, securityAuditLog,
  DateRange, TransactionStatus, Order, OrderLineItem, OrderModifier, OrderDiscount,
  InsertUser, User, InsertTransaction, Transaction,
  InsertGiftCard, GiftCard, InsertGiftCardRedemption, GiftCardRedemption,
  InsertOrder, InsertOrderLineItem, InsertOrderModifier, InsertOrderDiscount,
  OrderSummary, InsertSyncState, SyncState,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  InsertMcpQueryAudit, InsertSecurityAuditLog,
  appSettingsRegistry, AppSettingKey, AppSettingValue,
} from '@shared/schema';
import { getEasternDateRange, formatEasternDate, formatHour, EASTERN_TIMEZONE } from './dateUtils';
import { logger } from './logger';
import { formatInTimeZone } from 'date-fns-tz';
// Note: validateInsertData function needs to be implemented separately
// We're just doing a simple validation check in createOrder for now
import { InvalidOrderDataError, OrderNotFoundError } from './errors';

// Import IStorage interface from './storage'
import { IStorage, McpQueryAuditFilters, McpQueryAuditPage, SyncAuditFilters, SyncAuditPage, SyncAuditEntry, SecurityAuditFilters, SecurityAuditPage, TotpAuthAlertsFilters, TotpAuthAlertsPage } from './storage';

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

    const webResAdvResult = await db.execute(sql`
      SELECT COALESCE(SUM(gc.amount), 0) as web_res_adv_deposits
      FROM gift_cards gc
      INNER JOIN orders o ON o.square_id = gc.activation_square_order_id
      WHERE gc.amount > 0
        AND o.source IN ('Web Reservation', 'Web Reservation-Attraction', 'Multi Attractions Reservation')
    `);
    const webResAdvDeposits = Number(webResAdvResult.rows[0]?.web_res_adv_deposits) || 0;

    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue,
      outstandingBalance: soldAmount - redeemedAmount,
      webResAdvDeposits,
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

  // Security audit log (Task #100). One row per admin security action;
  // append-only by design — we never expose a delete or update route.
  async recordSecurityAudit(entry: InsertSecurityAuditLog): Promise<void> {
    await db.insert(securityAuditLog).values(entry);
  }

  // Transactional helpers (Task #100). Audit integrity demands the
  // state mutation and audit-log row commit (or fail) together — if the
  // audit insert blew up after the setting/disable already landed, we'd
  // silently lose the trail of who did what.
  async setAppSettingWithAudit<K extends AppSettingKey>(
    key: K,
    value: AppSettingValue<K>,
    audit: InsertSecurityAuditLog,
  ): Promise<void> {
    const schema = appSettingsRegistry[key];
    const parsed = schema.parse(value);
    await db.transaction(async (tx) => {
      await tx
        .insert(appSettings)
        .values({ key, value: parsed })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: parsed, updatedAt: sql`CURRENT_TIMESTAMP` },
        });
      await tx.insert(securityAuditLog).values(audit);
    });
  }

  // Delete the persisted row for `key` and write the audit row in the
  // same transaction (Task #182). Mirrors `setAppSettingWithAudit` so
  // an audit-write failure can't leave the row removed without the
  // accompanying trail. Used by the admin "Reset to default" action on
  // the App settings registry panel: dropping the row makes the
  // consumer fall back to its hard-coded default, which closes out a
  // broken/legacy row without a one-off migration. No-op-safe — if no
  // row exists the audit row still records the attempt.
  async deleteAppSettingWithAudit<K extends AppSettingKey>(
    key: K,
    audit: InsertSecurityAuditLog,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(appSettings).where(eq(appSettings.key, key));
      await tx.insert(securityAuditLog).values(audit);
    });
  }

  async disableUserTotpWithAudit(
    targetUserId: number,
    audit: InsertSecurityAuditLog,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          totpEnabled: false,
          totpSecretEncrypted: null,
          totpRecoveryCodes: null,
          totpLastUsedAt: null,
        })
        .where(eq(users.id, targetUserId));
      await tx.insert(securityAuditLog).values(audit);
    });
  }

  async pruneMcpQueryAudit(maxAgeDays: number): Promise<number> {
    const result = await db.execute(sql`
      DELETE FROM mcp_query_audit
      WHERE created_at < NOW() - (${maxAgeDays} || ' days')::interval
    `);
    return result.rowCount ?? 0;
  }

  async listMcpQueryAudit(filters: McpQueryAuditFilters): Promise<McpQueryAuditPage> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const conditions: any[] = [];
    if (filters.adminUsername && filters.adminUsername.trim() !== '') {
      const needle = `%${filters.adminUsername.trim().toLowerCase()}%`;
      conditions.push(sql`LOWER(u.username) LIKE ${needle}`);
    }
    if (filters.outcome === 'success') {
      conditions.push(sql`a.error IS NULL`);
    } else if (filters.outcome === 'error') {
      conditions.push(sql`a.error IS NOT NULL`);
    }
    if (filters.startDate) {
      conditions.push(sql`a.created_at >= ${filters.startDate.toISOString()}::timestamptz`);
    }
    if (filters.endDate) {
      conditions.push(sql`a.created_at <= ${filters.endDate.toISOString()}::timestamptz`);
    }

    const whereClause = conditions.length === 0
      ? sql``
      : sql`WHERE ${sql.join(conditions, sql` AND `)}`;

    const rowsResult = await db.execute(sql`
      SELECT a.id, a.admin_user_id, a.ip, a.query, a.row_count,
             a.error, a.duration_ms, a.created_at,
             u.username AS admin_username
      FROM mcp_query_audit a
      LEFT JOIN users u ON u.id = a.admin_user_id
      ${whereClause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM mcp_query_audit a
      LEFT JOIN users u ON u.id = a.admin_user_id
      ${whereClause}
    `);

    const entries = rowsResult.rows.map((row) => ({
      id: Number(row.id),
      adminUserId: row.admin_user_id === null ? null : Number(row.admin_user_id),
      ip: (row.ip as string | null) ?? null,
      query: row.query as string,
      rowCount: row.row_count === null ? null : Number(row.row_count),
      error: (row.error as string | null) ?? null,
      durationMs: Number(row.duration_ms),
      createdAt: new Date(row.created_at as string),
      adminUsername: (row.admin_username as string | null) ?? null,
    }));

    return {
      entries,
      total: Number(totalResult.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  }

  async listSyncAudit(filters: SyncAuditFilters): Promise<SyncAuditPage> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const whereClause = filters.syncType && filters.syncType.trim() !== ''
      ? sql`WHERE a.sync_type = ${filters.syncType.trim()}`
      : sql``;

    const rowsResult = await db.execute(sql`
      SELECT a.id, a.sync_type, a.action, a.actor_user_id, a.actor_ip,
             a.params, a.status, a.error_message, a.result, a.pages_used,
             a.started_at, a.completed_at,
             u.username AS actor_username
      FROM sync_audit a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ${whereClause}
      ORDER BY a.started_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM sync_audit a
      ${whereClause}
    `);

    const typesResult = await db.execute(sql`
      SELECT DISTINCT sync_type FROM sync_audit ORDER BY sync_type ASC
    `);

    const entries = rowsResult.rows.map((row) => ({
      id: Number(row.id),
      syncType: row.sync_type as string,
      action: row.action as string,
      actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
      actorIp: (row.actor_ip as string | null) ?? null,
      params: (row.params as Record<string, unknown> | null) ?? null,
      status: row.status as string,
      errorMessage: (row.error_message as string | null) ?? null,
      result: (row.result as Record<string, unknown> | null) ?? null,
      pagesUsed: Number(row.pages_used ?? 0),
      startedAt: new Date(row.started_at as string),
      completedAt: row.completed_at === null ? null : new Date(row.completed_at as string),
      actorUsername: (row.actor_username as string | null) ?? null,
    }));

    return {
      entries,
      total: Number(totalResult.rows[0]?.total ?? 0),
      limit,
      offset,
      syncTypes: typesResult.rows.map((r) => r.sync_type as string),
    };
  }

  // Paginated browser for the security_audit_log table (Task #126).
  // The table is intentionally append-only (see `recordSecurityAudit`
  // and the WithAudit transactional helpers above), so this is the
  // only read path the admin UI uses to investigate who turned a
  // security toggle on/off or who disabled another admin's 2FA.
  //
  // Joined with `users` (twice — once for the actor, once for the
  // target) via LEFT JOIN so a deleted account doesn't make its
  // historical rows vanish from the audit trail; the username comes
  // back as `null` and the UI labels it accordingly.
  //
  // Filters are kept simple per the task brief: action (exact match
  // against the action code), actor (substring against username),
  // target (substring against username). The distinct list of action
  // codes is returned alongside the page so the dropdown stays in
  // sync with whatever is actually in the table.
  async listSecurityAudit(filters: SecurityAuditFilters): Promise<SecurityAuditPage> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);

    const conditions: any[] = [];
    if (filters.action && filters.action.trim() !== '') {
      conditions.push(sql`a.action = ${filters.action.trim()}`);
    }
    if (filters.actorUsername && filters.actorUsername.trim() !== '') {
      const needle = `%${filters.actorUsername.trim().toLowerCase()}%`;
      conditions.push(sql`LOWER(actor.username) LIKE ${needle}`);
    }
    if (filters.targetUsername && filters.targetUsername.trim() !== '') {
      const needle = `%${filters.targetUsername.trim().toLowerCase()}%`;
      conditions.push(sql`LOWER(target.username) LIKE ${needle}`);
    }

    const whereClause = conditions.length === 0
      ? sql``
      : sql`WHERE ${sql.join(conditions, sql` AND `)}`;

    const rowsResult = await db.execute(sql`
      SELECT a.id, a.actor_user_id, a.actor_ip, a.action,
             a.target_user_id, a.metadata, a.created_at,
             actor.username AS actor_username,
             target.username AS target_username
      FROM security_audit_log a
      LEFT JOIN users actor ON actor.id = a.actor_user_id
      LEFT JOIN users target ON target.id = a.target_user_id
      ${whereClause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalResult = await db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM security_audit_log a
      LEFT JOIN users actor ON actor.id = a.actor_user_id
      LEFT JOIN users target ON target.id = a.target_user_id
      ${whereClause}
    `);

    const actionsResult = await db.execute(sql`
      SELECT DISTINCT action FROM security_audit_log ORDER BY action ASC
    `);

    const entries = rowsResult.rows.map((row) => ({
      id: Number(row.id),
      actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
      actorIp: (row.actor_ip as string | null) ?? null,
      action: row.action as string,
      targetUserId: row.target_user_id === null ? null : Number(row.target_user_id),
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      createdAt: new Date(row.created_at as string),
      actorUsername: (row.actor_username as string | null) ?? null,
      targetUsername: (row.target_username as string | null) ?? null,
    }));

    return {
      entries,
      total: Number(totalResult.rows[0]?.total ?? 0),
      limit,
      offset,
      actions: actionsResult.rows.map((r) => r.action as string),
    };
  }

  // Aggregated read for the in-product TOTP brute-force / recovery-
  // burst alerts panel (Task #177). Sister to the in-process
  // `totpAuthAlerter` webhook: same window + thresholds, but read
  // from the `security_audit_log` rows the totp service already
  // writes (`totp.login_failure`, `totp.recovery_code_used`) so the
  // panel survives a server restart and an operator who never wired
  // the webhook still sees the same set of accounts.
  //
  // We aggregate inside the SQL so the route handler can return
  // hundreds of accounts' worth of failures without round-tripping
  // every event row over the wire. `peak_attempt_count` comes from
  // the metadata JSON the totp service stores per failure — it
  // matches the criterion the alerter uses to fire on a single
  // hammered pending cookie even when only one log line landed.
  //
  // `target_user_id` is the canonical grouping key here. The totp
  // service writes both `actor_user_id` and `target_user_id` to the
  // same value (the user being verified), but the public face of a
  // brute-force alert is "which account is under attack", so we group
  // on the target side. Rows without a target_user_id (none today,
  // but defensive) are excluded from the aggregation.
  async listTotpAuthAlerts(
    filters: TotpAuthAlertsFilters,
  ): Promise<TotpAuthAlertsPage> {
    const generatedAt = new Date();
    const cutoff = new Date(generatedAt.getTime() - filters.windowMs);

    const bruteForceResult = await db.execute(sql`
      SELECT
        a.target_user_id AS user_id,
        u.username AS username,
        COUNT(*)::int AS failure_count,
        COALESCE(MAX((a.metadata->>'attemptCount')::int), 0) AS peak_attempt_count,
        MIN(a.created_at) AS first_event_at,
        MAX(a.created_at) AS last_event_at
      FROM security_audit_log a
      LEFT JOIN users u ON u.id = a.target_user_id
      WHERE a.action = 'totp.login_failure'
        AND a.target_user_id IS NOT NULL
        AND a.created_at >= ${cutoff.toISOString()}::timestamptz
      GROUP BY a.target_user_id, u.username
      HAVING COUNT(*) >= ${filters.failureThreshold}
          OR COALESCE(MAX((a.metadata->>'attemptCount')::int), 0) >= ${filters.failureThreshold}
      ORDER BY MAX(a.created_at) DESC, a.target_user_id ASC
    `);

    const recoveryResult = await db.execute(sql`
      SELECT
        a.target_user_id AS user_id,
        u.username AS username,
        COUNT(*)::int AS recovery_count,
        MIN(a.created_at) AS first_event_at,
        MAX(a.created_at) AS last_event_at
      FROM security_audit_log a
      LEFT JOIN users u ON u.id = a.target_user_id
      WHERE a.action = 'totp.recovery_code_used'
        AND a.target_user_id IS NOT NULL
        AND a.created_at >= ${cutoff.toISOString()}::timestamptz
      GROUP BY a.target_user_id, u.username
      HAVING COUNT(*) >= ${filters.recoveryThreshold}
      ORDER BY MAX(a.created_at) DESC, a.target_user_id ASC
    `);

    return {
      bruteForce: bruteForceResult.rows.map((row) => ({
        userId: Number(row.user_id),
        username: (row.username as string | null) ?? null,
        failureCount: Number(row.failure_count),
        peakAttemptCount: Number(row.peak_attempt_count ?? 0),
        firstEventAt: new Date(row.first_event_at as string),
        lastEventAt: new Date(row.last_event_at as string),
      })),
      recoveryBurst: recoveryResult.rows.map((row) => ({
        userId: Number(row.user_id),
        username: (row.username as string | null) ?? null,
        recoveryCount: Number(row.recovery_count),
        firstEventAt: new Date(row.first_event_at as string),
        lastEventAt: new Date(row.last_event_at as string),
      })),
      windowMs: filters.windowMs,
      failureThreshold: filters.failureThreshold,
      recoveryThreshold: filters.recoveryThreshold,
      generatedAt,
    };
  }

  // Bulk export of sync_audit rows for the admin "Download CSV"
  // affordance (Task #117). Mirrors the SELECT projection of
  // listSyncAudit so the CSV columns line up exactly with what the
  // browser shows, but skips pagination — the caller wants every row
  // matching the current filter, not just the visible page. A hard
  // safety cap keeps a runaway request from streaming millions of
  // rows into memory; sync_audit grows roughly one row per backfill
  // trigger so 10k is several years of headroom and any real overflow
  // is itself a signal worth investigating.
  async exportSyncAudit(filters: {
    syncType?: string;
    maxRows?: number;
  }): Promise<{ entries: SyncAuditEntry[]; truncated: boolean }> {
    const cap = Math.min(Math.max(filters.maxRows ?? 10_000, 1), 50_000);

    const whereClause = filters.syncType && filters.syncType.trim() !== ''
      ? sql`WHERE a.sync_type = ${filters.syncType.trim()}`
      : sql``;

    // Fetch one extra row beyond the cap so the caller can detect
    // truncation without a separate COUNT(*) round trip — if we got
    // back exactly cap+1 rows there's at least one matching row we
    // dropped, so the export is partial.
    const rowsResult = await db.execute(sql`
      SELECT a.id, a.sync_type, a.action, a.actor_user_id, a.actor_ip,
             a.params, a.status, a.error_message, a.result, a.pages_used,
             a.started_at, a.completed_at,
             u.username AS actor_username
      FROM sync_audit a
      LEFT JOIN users u ON u.id = a.actor_user_id
      ${whereClause}
      ORDER BY a.started_at DESC, a.id DESC
      LIMIT ${cap + 1}
    `);

    const truncated = rowsResult.rows.length > cap;
    const sliced = truncated ? rowsResult.rows.slice(0, cap) : rowsResult.rows;

    const entries = sliced.map((row) => ({
      id: Number(row.id),
      syncType: row.sync_type as string,
      action: row.action as string,
      actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
      actorIp: (row.actor_ip as string | null) ?? null,
      params: (row.params as Record<string, unknown> | null) ?? null,
      status: row.status as string,
      errorMessage: (row.error_message as string | null) ?? null,
      result: (row.result as Record<string, unknown> | null) ?? null,
      pagesUsed: Number(row.pages_used ?? 0),
      startedAt: new Date(row.started_at as string),
      completedAt: row.completed_at === null ? null : new Date(row.completed_at as string),
      actorUsername: (row.actor_username as string | null) ?? null,
    }));

    return { entries, truncated };
  }

  // Per-deployment runtime settings. The key/value pair is constrained
  // by `appSettingsRegistry` in shared/schema.ts so callers get a typed
  // value back and cannot accidentally store the wrong shape under a
  // key. The stored JSON is re-validated against the registered schema
  // on read; a malformed/legacy row is logged and surfaces as
  // `undefined` so consumers fall back to their defaults rather than
  // receive a wrong-shape value.
  //
  // Runbook for `app_settings.invalid_row` (Task #122):
  //   When a row fails schema validation here, the storage layer logs
  //   the event AND fires a webhook alert via
  //   `recordAppSettingsInvalidRowForAlerting` so on-call notices
  //   *before* an incident. Do NOT fix the offending row by hand-
  //   editing it in psql — that's exactly the class of change that
  //   produced the alert in the first place. Instead, ship a one-off
  //   migration that either rewrites the row to the new shape (if the
  //   schema change was intentional and the field can be defaulted)
  //   or deletes the row entirely so the consumer's default kicks in.
  //   See `server/services/appSettingsInvalidRowAlert.ts` for the
  //   full alerter contract and cooldown semantics.
  async getAppSetting<K extends AppSettingKey>(
    key: K,
  ): Promise<AppSettingValue<K> | undefined> {
    const rows = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key));
    if (rows.length === 0) return undefined;
    const schema = appSettingsRegistry[key];
    const parsed = schema.safeParse(rows[0].value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      logger.warn('app_settings.invalid_row', { key, issues });
      // Lazy-import to avoid a hard dependency at module-load time —
      // the alerter pulls in the env-config snapshot when first used,
      // which would otherwise be evaluated before tests can stub env.
      // Guarded so an alerter-side fault (failed import, throwing
      // notifier) can never escalate from "missing alert" to "broken
      // settings read" — the consumer's `undefined` fallback contract
      // takes priority over the alert.
      try {
        const { recordAppSettingsInvalidRowForAlerting } = await import(
          './services/appSettingsInvalidRowAlert'
        );
        recordAppSettingsInvalidRowForAlerting(key, issues);
      } catch (err) {
        logger.warn('app_settings.invalid_row_alert.invoke_failed', {
          key,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      return undefined;
    }
    // Successful read — tell the alerter so any leftover per-key
    // cooldown from a prior invalid-row alert is cleared (Task #168).
    // Without this, a fix-up migration shipped *during* the cooldown
    // window would leave the alerter quietly suppressing the next
    // genuine break of the same key. Same lazy-import + guarded
    // pattern as the failure branch so a recovery-side fault can't
    // escalate into a broken settings read.
    try {
      const { recordAppSettingsRecoveryForAlerting } = await import(
        './services/appSettingsInvalidRowAlert'
      );
      recordAppSettingsRecoveryForAlerting(key);
    } catch (err) {
      logger.warn('app_settings.invalid_row_recovery.invoke_failed', {
        key,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    return parsed.data as AppSettingValue<K>;
  }

  async setAppSetting<K extends AppSettingKey>(
    key: K,
    value: AppSettingValue<K>,
  ): Promise<void> {
    // Defence-in-depth: validate against the registered schema even
    // though TypeScript already narrows `value`, so a bad runtime
    // payload (e.g. from a future caller bypassing types) is rejected
    // before it reaches the DB.
    const schema = appSettingsRegistry[key];
    const parsed = schema.parse(value);
    // Upsert keeps the table at most one row per key. updated_at is
    // refreshed on every write so admins can audit when a setting last
    // changed via DB inspection.
    await db
      .insert(appSettings)
      .values({ key, value: parsed })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: parsed, updatedAt: sql`CURRENT_TIMESTAMP` },
      });
  }

  // Walk every key registered in `appSettingsRegistry`, fetch its
  // current persisted row (if any), and re-validate it against the
  // registered zod schema. Powers the admin "App settings registry"
  // panel (Task #167) so an operator who joins after the one-shot
  // invalid-row alert has fired can still see at a glance which keys
  // are currently broken — without ssh-ing into the box and
  // re-triggering a read.
  //
  // Read-only and side-effect free: this does NOT call into
  // `recordAppSettingsInvalidRowForAlerting`, on purpose. The alerter's
  // per-key cooldown is sized for a real read path (one alert per
  // broken row per hour); having an admin pull the panel be able to
  // re-arm or duplicate alerts would defeat that quiet-period
  // contract. The alerter remains driven exclusively by
  // `getAppSetting`.
  async validateAllAppSettings(): Promise<AppSettingsRegistryValidationEntry[]> {
    const keys = Object.keys(appSettingsRegistry) as AppSettingKey[];
    const validatedAt = new Date().toISOString();

    if (keys.length === 0) return [];

    const rows = await db
      .select({
        key: appSettings.key,
        value: appSettings.value,
        updatedAt: appSettings.updatedAt,
      })
      .from(appSettings)
      .where(inArray(appSettings.key, keys as unknown as string[]));

    const rowByKey = new Map(rows.map((r) => [r.key, r]));

    return keys.map((key) => {
      const row = rowByKey.get(key);
      const updatedAt =
        row?.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : row?.updatedAt
            ? new Date(row.updatedAt as unknown as string).toISOString()
            : null;

      // No row at all is the "fall back to defaults" path — a
      // perfectly normal state on a fresh deploy where the operator
      // hasn't tuned the setting yet. Surface it as a distinct
      // status so the panel doesn't paint untouched keys red.
      if (!row) {
        return {
          key,
          status: 'missing' as const,
          issues: [],
          updatedAt: null,
          validatedAt,
        };
      }

      const schema = appSettingsRegistry[key];
      const parsed = schema.safeParse(row.value);
      if (parsed.success) {
        return {
          key,
          status: 'valid' as const,
          issues: [],
          updatedAt,
          validatedAt,
        };
      }

      return {
        key,
        status: 'invalid' as const,
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
        updatedAt,
        validatedAt,
      };
    });
  }
}

export interface AppSettingsRegistryValidationIssue {
  path: string;
  message: string;
}

export interface AppSettingsRegistryValidationEntry {
  key: AppSettingKey;
  /**
   * `valid`   — row exists and matches the registered schema.
   * `invalid` — row exists but the JSON failed schema validation.
   *             `issues` will be populated with the zod issue list.
   * `missing` — no row in `app_settings` for this key. Consumers
   *             fall back to their built-in defaults; this is a
   *             healthy state, not an error.
   */
  status: 'valid' | 'invalid' | 'missing';
  issues: AppSettingsRegistryValidationIssue[];
  /** ISO8601 of the row's `updated_at`, or null when status='missing'. */
  updatedAt: string | null;
  /** ISO8601 of when this validation pass ran. */
  validatedAt: string;
}

export const pgStorage = new PgStorage();