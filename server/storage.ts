import { 
  Transaction, InsertTransaction, 
  GiftCard, InsertGiftCard, 
  GiftCardRedemption, InsertGiftCardRedemption,
  User, InsertUser,
  SyncState, InsertSyncState,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  DateRange, TransactionStatus,
  Order, InsertOrder,
  OrderLineItem, InsertOrderLineItem,
  OrderModifier, InsertOrderModifier,
  OrderDiscount, InsertOrderDiscount,
  OrderSummary,
  InsertMcpQueryAudit,
  InsertSecurityAuditLog,
  McpQueryAudit,
  SyncAudit,
  AppSettingKey,
  AppSettingValue,
} from "@shared/schema";

export interface McpQueryAuditFilters {
  adminUsername?: string;
  outcome?: 'success' | 'error';
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface McpQueryAuditEntry extends McpQueryAudit {
  adminUsername: string | null;
}

export interface McpQueryAuditPage {
  entries: McpQueryAuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SyncAuditFilters {
  syncType?: string;
  limit?: number;
  offset?: number;
}

export interface SyncAuditEntry extends SyncAudit {
  actorUsername: string | null;
}

export interface SyncAuditPage {
  entries: SyncAuditEntry[];
  total: number;
  limit: number;
  offset: number;
  syncTypes: string[];
}

import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } from "date-fns";

export interface IStorage {
  // User methods (keeping from original)
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  getAllUsers(): Promise<User[]>;

  // Transaction methods
  getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date, status?: TransactionStatus): Promise<Transaction[]>;
  getTransactionById(id: number): Promise<Transaction | undefined>;
  getTransactionBySquareId(squareId: string): Promise<Transaction | undefined>;
  createTransaction(transaction: InsertTransaction): Promise<Transaction>;

  // Gift card methods
  getGiftCards(): Promise<GiftCard[]>;
  getGiftCardById(id: number): Promise<GiftCard | undefined>;
  getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined>;
  createGiftCard(giftCard: InsertGiftCard): Promise<GiftCard>;
  updateGiftCardRedemption(id: number, amount: number): Promise<GiftCard>;

  // Gift card redemption methods
  createGiftCardRedemption(redemption: InsertGiftCardRedemption): Promise<GiftCardRedemption>;
  getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]>;

  // Dashboard summary methods
  getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary>;
  getCategoryRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<CategoryRevenue[]>;
  getHourlyRevenue(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<HourlyRevenue[]>;
  getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary>;

  // Sync state management methods
  getSyncState(syncType: string): Promise<SyncState | undefined>;
  createSyncState(syncState: InsertSyncState): Promise<SyncState>;
  updateSyncState(id: number, updates: Partial<InsertSyncState>): Promise<SyncState>;
  getSyncProgress(): Promise<{ payments: number; giftCards: number; }>;

  // Order methods
  getOrder(id: number): Promise<Order | undefined>;
  getOrderBySquareId(squareId: string): Promise<Order | undefined>;
  createOrder(order: InsertOrder): Promise<Order>;
  getOrderItems(orderId: number): Promise<OrderLineItem[]>;
  createOrderItem(item: InsertOrderLineItem): Promise<OrderLineItem>;
  getOrderModifiers(lineItemId: number): Promise<OrderModifier[]>;
  createOrderModifier(modifier: InsertOrderModifier): Promise<OrderModifier>;
  getOrderDiscounts(orderId: number): Promise<OrderDiscount[]>;
  createOrderDiscount(discount: InsertOrderDiscount): Promise<OrderDiscount>;
  getOrderSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<OrderSummary>;

  // Add new method for gift card sales
  getGiftCardSales(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<number>;

  // MCP read-query audit log
  recordMcpQueryAudit(entry: InsertMcpQueryAudit): Promise<void>;
  pruneMcpQueryAudit(maxAgeDays: number): Promise<number>;
  listMcpQueryAudit(filters: McpQueryAuditFilters): Promise<McpQueryAuditPage>;

  // Sync audit log (historical/backfill triggers)
  listSyncAudit(filters: SyncAuditFilters): Promise<SyncAuditPage>;
  // Bulk export of the same audit table for the admin "Download CSV"
  // affordance (Task #117). Returns up to `maxRows` matching entries
  // ordered newest-first, with no pagination — the caller is expected
  // to apply the cap (we hard-cap inside as a safety net regardless).
  exportSyncAudit(filters: { syncType?: string; maxRows?: number }): Promise<SyncAuditEntry[]>;

  // Security audit log (admin 2FA actions, Task #100). Append-only —
  // there is intentionally no "delete" or "update" entry point so a
  // compromised admin cannot scrub their own actions.
  recordSecurityAudit(entry: InsertSecurityAuditLog): Promise<void>;

  // Per-deployment runtime settings (app_settings table). The key is
  // constrained to the typed registry in `shared/schema.ts`, and the
  // value is the zod-inferred shape for that key — no `unknown` or
  // `as object` casts at the call site. Implementations validate the
  // stored row against the registry schema before returning so a
  // malformed/legacy row surfaces as `undefined` rather than a wrong-
  // shape value reaching the consumer.
  getAppSetting<K extends AppSettingKey>(
    key: K,
  ): Promise<AppSettingValue<K> | undefined>;
  setAppSetting<K extends AppSettingKey>(
    key: K,
    value: AppSettingValue<K>,
  ): Promise<void>;
}

// No MemStorage implementation - we now exclusively use PgStorage for all data storage
// This file only contains the IStorage interface definition