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
  SecurityAuditLog,
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

export interface SecurityAuditFilters {
  // Free-form action string (e.g. "require_admin_2fa.set"). When set,
  // only rows whose `action` column matches exactly are returned —
  // partial/substring matching would muddy the filter for short
  // prefixes ("user.") so we keep this strict and let the UI populate
  // a dropdown from the distinct list returned alongside the page.
  action?: string;
  // Substring match against the actor's username (the admin who took
  // the action). LEFT JOIN with users so an action whose actor was
  // since-deleted still shows up under "(unknown)" rather than
  // disappearing from the audit trail.
  actorUsername?: string;
  // Substring match against the target user's username (the account
  // the action was applied to, when applicable). Same LEFT JOIN
  // semantics as actorUsername.
  targetUsername?: string;
  limit?: number;
  offset?: number;
}

export interface SecurityAuditEntry extends SecurityAuditLog {
  actorUsername: string | null;
  targetUsername: string | null;
}

export interface SecurityAuditPage {
  entries: SecurityAuditEntry[];
  total: number;
  limit: number;
  offset: number;
  // Distinct action strings present in the table, ascending. The UI
  // uses this to populate a filter dropdown without hard-coding the
  // current set of action codes — new actions added by future tasks
  // surface automatically.
  actions: string[];
}

// ---------------------------------------------------------------------
// In-app surface for the TOTP brute-force / recovery-code-burst
// alerter (Task #177). The webhook in `totpAuthAlert.ts` is the
// real-time channel; this type backs the read-only admin panel that
// shows the same per-account aggregations sourced from the
// security_audit_log table (so it persists across server restarts and
// is identical to what the webhook would have fired on).
// ---------------------------------------------------------------------
export interface TotpAuthAlertsFilters {
  // How far back the aggregation window stretches. Mirrors
  // `TOTP_AUTH_ALERT_WINDOW_MS` so the panel surfaces the same set of
  // accounts the in-process alerter would have fired on. The route
  // layer defaults this to the alerter's current config.
  windowMs: number;
  // Minimum count required for an account to appear in the
  // brute-force alert list. Mirrors `TOTP_AUTH_ALERT_FAILURE_THRESHOLD`.
  failureThreshold: number;
  // Minimum count required for an account to appear in the
  // recovery-code-burst list. Mirrors `TOTP_AUTH_ALERT_RECOVERY_THRESHOLD`.
  recoveryThreshold: number;
}

export interface TotpBruteForceAlertRow {
  userId: number;
  username: string | null;
  failureCount: number;
  // Highest `attemptCount` recorded across the events in the window.
  // The alerter fires on either the rolling count crossing the
  // threshold OR a single event reporting an attemptCount above it,
  // so this is the headline number an operator wants to see.
  peakAttemptCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
}

export interface TotpRecoveryBurstAlertRow {
  userId: number;
  username: string | null;
  recoveryCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
}

export interface TotpAuthAlertsPage {
  bruteForce: TotpBruteForceAlertRow[];
  recoveryBurst: TotpRecoveryBurstAlertRow[];
  // Echo the resolved window and thresholds back to the caller so the
  // UI can label the panel ("brute-force alerts in the last 15m,
  // threshold 5") without having to recompute them from env hints.
  windowMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  // Server clock at the moment the aggregation ran, so the UI's
  // "fired N seconds ago" label uses the server's notion of "now"
  // and stays consistent if the operator's local clock is skewed.
  generatedAt: Date;
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
  // The `truncated` flag tells the caller whether more matching rows
  // existed beyond the cap so the response can warn instead of
  // silently handing back a partial export.
  exportSyncAudit(filters: {
    syncType?: string;
    maxRows?: number;
  }): Promise<{ entries: SyncAuditEntry[]; truncated: boolean }>;

  // Security audit log (admin 2FA actions, Task #100). Append-only —
  // there is intentionally no "delete" or "update" entry point so a
  // compromised admin cannot scrub their own actions.
  recordSecurityAudit(entry: InsertSecurityAuditLog): Promise<void>;
  // Paginated browser for the same table (Task #126). Newest-first,
  // joined with `users` so the UI can show usernames instead of bare
  // numeric IDs. Returns the distinct list of action codes alongside
  // the page so the front-end can populate a filter dropdown without
  // having to hard-code the current set of action strings.
  listSecurityAudit(filters: SecurityAuditFilters): Promise<SecurityAuditPage>;

  // Aggregated view of recent TOTP brute-force / recovery-code-burst
  // alerts (Task #177). Reads `security_audit_log` rows whose action
  // is `totp.login_failure` or `totp.recovery_code_used`, groups by
  // target account inside the window, and returns only those rows
  // crossing the alerter's thresholds. Backed by the same audit table
  // the webhook fires off, so the panel persists across server
  // restarts and surfaces the same accounts the in-process alerter
  // would have alerted on.
  listTotpAuthAlerts(filters: TotpAuthAlertsFilters): Promise<TotpAuthAlertsPage>;

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