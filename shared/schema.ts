import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  real,
  jsonb,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Define possible date ranges for filtering
export const dateRangeSchema = z.enum([
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "thisMonth",
  "lastMonth",
  "yearToDate",
  "custom",
]);

export type DateRange = z.infer<typeof dateRangeSchema>;

// Transaction status types
export const transactionStatusSchema = z.enum([
  "completed",
  "refunded",
  "failed",
  "pending",
]);

export type TransactionStatus = z.infer<typeof transactionStatusSchema>;

// Transaction categories — now a free-form string so any Square catalog category is accepted
export const categorySchema = z.string();

export type Category = z.infer<typeof categorySchema>;

// Order status types
export const orderStatusSchema = z.enum([
  "OPEN",
  "COMPLETED",
  "CANCELED",
  "DRAFT",
  "PENDING"
]);

export type OrderStatus = z.infer<typeof orderStatusSchema>;

// Orders table
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  status: text("status").notNull(),
  totalMoney: real("total_money").notNull(),
  totalTax: real("total_tax").notNull(),
  totalDiscount: real("total_discount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  transactionId: integer("transaction_id").references(() => transactions.id),
  source: text("source").notNull(),
  squareData: jsonb("square_data"),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

// Order line items
export const orderLineItems = pgTable("order_line_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  quantity: real("quantity").notNull(),
  basePriceMoney: real("base_price_money").notNull(),
  totalMoney: real("total_money").notNull(),
  category: text("category"),
  productId: text("product_id"),
  isGiftCard: boolean("is_gift_card"),
  squareData: jsonb("square_data"),
});

export const insertOrderLineItemSchema = createInsertSchema(orderLineItems).omit({
  id: true,
});

export type InsertOrderLineItem = z.infer<typeof insertOrderLineItemSchema>;
export type OrderLineItem = typeof orderLineItems.$inferSelect;

// Order modifiers
export const orderModifiers = pgTable("order_modifiers", {
  id: serial("id").primaryKey(),
  lineItemId: integer("line_item_id").notNull().references(() => orderLineItems.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  basePriceMoney: real("base_price_money"),
  totalPriceMoney: real("total_price_money"),
  squareData: jsonb("square_data"),
});

export const insertOrderModifierSchema = createInsertSchema(orderModifiers).omit({
  id: true,
});

export type InsertOrderModifier = z.infer<typeof insertOrderModifierSchema>;
export type OrderModifier = typeof orderModifiers.$inferSelect;

// Order discounts
export const orderDiscounts = pgTable("order_discounts", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => orders.id, {
    onDelete: "cascade"
  }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  percentage: real("percentage"),
  amountMoney: real("amount_money"),
  appliedMoney: real("applied_money").notNull(),
  scope: text("scope").notNull(),
  squareData: jsonb("square_data"),
});

export const insertOrderDiscountSchema = createInsertSchema(orderDiscounts).omit({
  id: true,
});

export type InsertOrderDiscount = z.infer<typeof insertOrderDiscountSchema>;
export type OrderDiscount = typeof orderDiscounts.$inferSelect;

// Main transactions table
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  amount: real("amount").notNull(),
  categoryId: text("category_id").notNull(),
  status: text("status").notNull(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  squareData: jsonb("square_data"),
});

export const insertTransactionSchema = createInsertSchema(transactions).omit({
  id: true,
});

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactions.$inferSelect;

// Gift card table
export const giftCards = pgTable("gift_cards", {
  id: serial("id").primaryKey(),
  squareId: text("square_id").notNull().unique(),
  amount: real("amount").notNull(),
  redeemedAmount: real("redeemed_amount").default(0).notNull(),
  activationAmount: real("activation_amount"), // Original amount when activated
  isActive: boolean("is_active").default(true).notNull(),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }).notNull(),
  squareData: jsonb("square_data"),
  gan: text("gan"), // Gift Card Account Number for matching with orders
  activationPaymentId: integer("activation_payment_id"), // FK to payments.id (exists in DB, payments table not in Drizzle schema)
  activationOrderId: integer("activation_order_id").references(() => orders.id), // Link to order when activated
  activationSquareOrderId: text("activation_square_order_id"), // Original Square order ID for matching
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertGiftCardSchema = createInsertSchema(giftCards).omit({
  id: true,
});

export type InsertGiftCard = z.infer<typeof insertGiftCardSchema>;
export type GiftCard = typeof giftCards.$inferSelect;

// Refunds table — tracks Square PaymentRefund objects
export const refunds = pgTable("refunds", {
  id: serial("id").primaryKey(),
  squareRefundId: text("square_refund_id").notNull().unique(),
  squarePaymentId: text("square_payment_id").notNull(),
  amount: real("amount").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  squareData: jsonb("square_data"),
});

export const insertRefundSchema = createInsertSchema(refunds).omit({
  id: true,
});

export type InsertRefund = z.infer<typeof insertRefundSchema>;
export type Refund = typeof refunds.$inferSelect;

// Gift card redemptions table
export const giftCardRedemptions = pgTable("gift_card_redemptions", {
  id: serial("id").primaryKey(),
  giftCardId: integer("gift_card_id").notNull().references(() => giftCards.id),
  amount: real("amount").notNull(),
  transactionId: integer("transaction_id").notNull().references(() => transactions.id),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
});

export const insertGiftCardRedemptionSchema = createInsertSchema(
  giftCardRedemptions,
).omit({
  id: true,
});

export type InsertGiftCardRedemption = z.infer<typeof insertGiftCardRedemptionSchema>;
export type GiftCardRedemption = typeof giftCardRedemptions.$inferSelect;

// Payout fee entries — tracks per-transaction fee data from Square Payouts API
export const payoutFeeEntries = pgTable("payout_fee_entries", {
  id: serial("id").primaryKey(),
  payoutId: text("payout_id").notNull(),
  entryId: text("entry_id").notNull().unique(),
  type: text("type").notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  grossAmount: real("gross_amount").notNull(),
  feeAmount: real("fee_amount").notNull(),
  netAmount: real("net_amount").notNull(),
  paymentId: text("payment_id"),
});

export const insertPayoutFeeEntrySchema = createInsertSchema(payoutFeeEntries).omit({
  id: true,
});

export type InsertPayoutFeeEntry = z.infer<typeof insertPayoutFeeEntrySchema>;
export type PayoutFeeEntry = typeof payoutFeeEntries.$inferSelect;

// Intercard revenue records — stores synced revenue data from Intercard API
export const intercardRevenue = pgTable("intercard_revenue", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  locationId: text("location_id").notNull(),
  deviceType: text("device_type").notNull(),
  deviceName: text("device_name").notNull(),
  cashRevenue: real("cash_revenue").notNull().default(0),
  creditCardRevenue: real("credit_card_revenue").notNull().default(0),
  cashRefunds: real("cash_refunds").notNull().default(0),
  creditRefunds: real("credit_refunds").notNull().default(0),
  otherPayment: real("other_payment").notNull().default(0),
  customerCardUse: real("customer_card_use").notNull().default(0),
  revenue: real("revenue").notNull().default(0),
  syncedAt: timestamp("synced_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertIntercardRevenueSchema = createInsertSchema(intercardRevenue).omit({
  id: true,
});

export type InsertIntercardRevenue = z.infer<typeof insertIntercardRevenueSchema>;
export type IntercardRevenue = typeof intercardRevenue.$inferSelect;

// Keep the users table for authentication
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").default("user").notNull(),
  // Per-account lockout state. failedLoginCount counts consecutive failed
  // password attempts; it is reset to 0 on a successful login. lockedUntil,
  // when set to a future timestamp, blocks login attempts for the account
  // regardless of source IP (see authService.loginUser).
  failedLoginCount: integer("failed_login_count").default(0).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  role: true,
});

// Strong password policy applied to anything that *creates or changes* a
// password (registration, admin-create, password reset). The login schema
// stays permissive so existing accounts with shorter passwords can still
// sign in and rotate their password later.
//
// Policy: 12-128 chars, must contain at least one letter and at least one
// digit. Intentionally simple; we do not require symbols or mixed case.
export const strongPasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => /[A-Za-z]/.test(p), {
    message: 'Password must contain at least one letter',
  })
  .refine((p) => /[0-9]/.test(p), {
    message: 'Password must contain at least one digit',
  });

// Public self-registration: role is never accepted from the request.
export const selfRegisterSchema = z.object({
  username: z.string().min(3).max(50),
  password: strongPasswordSchema,
});

// Admin-create: an authenticated admin may choose the new user's role.
export const adminCreateUserSchema = z.object({
  username: z.string().min(3).max(50),
  password: strongPasswordSchema,
  role: z.enum(['user', 'admin']).default('user'),
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type SelfRegisterInput = z.infer<typeof selfRegisterSchema>;
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
export type User = typeof users.$inferSelect;

// Sync state table to track Square data synchronization progress
export const syncState = pgTable("sync_state", {
  id: serial("id").primaryKey(),
  syncType: text("sync_type").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull(),
  currentPage: integer("current_page").default(1),
  totalPages: integer("total_pages").default(0),
  processedCount: integer("processed_count").default(0),
  totalCount: integer("total_count").default(0),
  cursor: text("cursor").default(""),
  isComplete: boolean("is_complete").default(false),
  status: text("status").default("pending"),
  errorMessage: text("error_message"),
  lastCheckpoint: jsonb("last_checkpoint"),
});

export const insertSyncStateSchema = createInsertSchema(syncState).omit({
  id: true,
});

export type InsertSyncState = z.infer<typeof insertSyncStateSchema>;
export type SyncState = typeof syncState.$inferSelect;

// Square catalog categories cache — stores real category names from Square's Catalog API
export const squareCategories = pgTable("square_categories", {
  id: serial("id").primaryKey(),
  squareCategoryId: text("square_category_id").notNull().unique(),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSquareCategorySchema = createInsertSchema(squareCategories).omit({
  id: true,
});

export type InsertSquareCategory = z.infer<typeof insertSquareCategorySchema>;
export type SquareCategory = typeof squareCategories.$inferSelect;

// Square catalog items cache — maps catalog object IDs to their category
export const squareCatalogItems = pgTable("square_catalog_items", {
  id: serial("id").primaryKey(),
  squareCatalogObjectId: text("square_catalog_object_id").notNull().unique(),
  categoryId: text("category_id"),
  categoryName: text("category_name"),
  itemName: text("item_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertSquareCatalogItemSchema = createInsertSchema(squareCatalogItems).omit({
  id: true,
});

export type InsertSquareCatalogItem = z.infer<typeof insertSquareCatalogItemSchema>;
export type SquareCatalogItem = typeof squareCatalogItems.$inferSelect;

// Add Order Summary type for dashboard
export interface OrderSummary {
  totalOrders: number;
  totalRevenue: number;
  averageOrderValue: number;
  itemsSold: number;
  topSellingItems: Array<{
    name: string;
    quantity: number;
    revenue: number;
  }>;
  discountTotal: number;
  taxTotal: number;
}

export interface DailySummary {
  totalRevenue: number;
  grossPayments: number;
  refunds: number;
  returns: number;
  giftCardRedemptions: number;
  depositClearings: number;
  partywirksDeposits: number;
  tripleseatDeposits: number;
  revenueChange: number;
  totalOrders: number;
  ordersChange: number;
  averageOrder: number;
  averageOrderChange: number;
  giftCardSales: number;
  giftCardSalesChange: number;
  date: string;
}

export interface CategoryRevenue {
  category: string;
  amount: number;
  color: string;
}

export interface HourlyRevenue {
  hour: string;
  amount: number;
}

export interface GiftCardSummary {
  soldCount: number;
  soldAmount: number;
  redeemedCount: number;
  redeemedAmount: number;
  averageValue: number;
  outstandingBalance: number;
  webResAdvDeposits: number;
}

export interface ProcessingFeeBreakdown {
  initialFees: number;
  reimbursements: number;
  thirdPartyFees: number;
  netFees: number;
}

export interface GcRedemptionBreakdown {
  bowlingDepositRedemptions: number;
  laserTagDepositRedemptions: number;
  giftCardRedemptions: number;
}

export interface DetailedTransactionBreakdown {
  partywirks: number;
  bowlingWebResDeposits: number;
  laserTagWebResDeposits: number;
  tripleseat: number;
  tips: number;
  serviceCharges: number;
  autoGratuity: number;
  taxes: number;
  refunds: number;
  returns: number;
  discountsAndComps: number;
  depositClearings: number;
  giftCardSales: number;
  giftCardRedemptions: number;
  gcRedemptionBreakdown: GcRedemptionBreakdown;
  processingFees: ProcessingFeeBreakdown;
  intercardRevenue: number;
  intercardCashRevenue: number;
  intercardCreditRevenue: number;
  squareIntercardKioskCash: number;
  totalTransactions: number;
}