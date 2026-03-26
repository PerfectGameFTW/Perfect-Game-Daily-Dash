import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dashboardService } from "./services/dashboardService";
import { giftCardService } from "./services/giftCardService";
import { paymentService } from "./services/paymentService";
import { orderService } from "./services/orderService";
import { intercardService } from "./services/intercardService";
import { payoutService } from "./services/payoutService";
import { db, sql } from "./db";
import {
  orders,
  orderLineItems,
  transactions,
  giftCards,
  refunds,
  intercardRevenue,
  syncState,
  type DateRange,
} from "../shared/schema";
import { getEasternDateRange, getEasternBusinessDateStrings } from "./dateUtils";

const server = new McpServer({
  name: "perfect-game-sales",
  version: "1.0.0",
});

const dateRangeValues = [
  "today",
  "yesterday",
  "last7days",
  "last30days",
  "thisMonth",
  "lastMonth",
  "custom",
] as const;

const dateRangeParam = {
  dateRange: z
    .enum(dateRangeValues)
    .default("today")
    .describe(
      "Preset date range. Use 'custom' with startDate/endDate for specific dates."
    ),
  startDate: z
    .string()
    .optional()
    .describe("Start date in YYYY-MM-DD format (required when dateRange is 'custom')"),
  endDate: z
    .string()
    .optional()
    .describe("End date in YYYY-MM-DD format (required when dateRange is 'custom')"),
};

function parseAndValidateDate(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: '${dateStr}'. Use YYYY-MM-DD format.`);
  }
  return d;
}

function parseDates(params: {
  dateRange: string;
  startDate?: string;
  endDate?: string;
}): { dateRange: DateRange; startDate?: Date; endDate?: Date } {
  const dateRange = params.dateRange as DateRange;
  let startDate: Date | undefined;
  let endDate: Date | undefined;
  if (dateRange === "custom") {
    if (!params.startDate || !params.endDate) {
      throw new Error("startDate and endDate are required when dateRange is 'custom'.");
    }
    startDate = parseAndValidateDate(params.startDate);
    endDate = parseAndValidateDate(params.endDate);
    if (startDate > endDate) {
      throw new Error(`startDate (${params.startDate}) must be before endDate (${params.endDate}).`);
    }
  }
  return { dateRange, startDate, endDate };
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

async function safeTool<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof errorResponse>> {
  try {
    return await fn();
  } catch (err) {
    return errorResponse(err);
  }
}

server.tool(
  "get_daily_summary",
  "Get a high-level daily revenue summary including total revenue, gross payments, refunds, returns, gift card redemptions, order count, average order value, and period-over-period changes. This is the main KPI overview.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const summary = await dashboardService.getDailySummary(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  })
);

server.tool(
  "get_detailed_breakdown",
  "Get a detailed breakdown of all revenue categories: tips, taxes, service charges, auto-gratuity, refunds, returns, discounts, gift card sales/redemptions (split by bowling deposits, laser tag deposits, true gift cards), Partywirks deposits, Tripleseat deposits, bowling/laser tag web reservation deposits, Intercard arcade revenue (cash/credit split), CC processing fees, and total transaction count.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const breakdown = await dashboardService.getDetailedTransactionBreakdown(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(breakdown, null, 2) }] };
  })
);

server.tool(
  "get_hourly_revenue",
  "Get revenue broken down by hour of the day (Eastern Time). Useful for identifying peak business hours and staffing optimization.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const hourly = await dashboardService.getHourlyRevenue(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(hourly, null, 2) }] };
  })
);

server.tool(
  "get_category_revenue",
  "Get revenue broken down by product category (food, drinks, retail, services, gift cards). Useful for understanding the revenue mix.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const categories = await dashboardService.getCategoryRevenue(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(categories, null, 2) }] };
  })
);

server.tool(
  "get_gift_card_summary",
  "Get gift card activity summary: total sold count/amount, redeemed count/amount, average gift card value, and outstanding balance for the period.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const summary = await giftCardService.getGiftCardSummary(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
  })
);

server.tool(
  "get_gift_card_breakdown",
  "Get detailed gift card deposits breakdown: bowling web reservation deposits, laser tag web reservation deposits, and true gift card sales. Shows how gift card activations split between deposit types and actual gift card purchases.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const breakdown = await giftCardService.getGiftCardBreakdown(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(breakdown, null, 2) }] };
  })
);

server.tool(
  "get_top_selling_items",
  "Get the top selling menu/product items by quantity sold for a date range. Returns item name, quantity sold, and total revenue per item.",
  {
    ...dateRangeParam,
    limit: z.number().int().min(1).max(100).default(20).describe("Number of top items to return (1-100, default 20)"),
  },
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const topItems = await db
      .execute<{ name: string; total_qty: number; total_revenue: number }>(sql`
        SELECT li.name, SUM(li.quantity)::numeric AS total_qty, SUM(li.total_money)::numeric AS total_revenue
        FROM ${orderLineItems} li JOIN ${orders} o ON o.id = li.order_id
        WHERE o.created_at BETWEEN ${start} AND ${end} AND o.status = 'COMPLETED'
        GROUP BY li.name ORDER BY total_qty DESC LIMIT ${params.limit}
      `)
      .then((r) => r.rows);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(topItems.map((i) => ({ name: i.name, quantitySold: Number(i.total_qty), revenue: Number(i.total_revenue) })), null, 2),
      }],
    };
  })
);

server.tool(
  "get_intercard_revenue",
  "Get arcade (Intercard) revenue for a date range. Returns cash revenue, credit card revenue, and total. Intercard is the arcade game card kiosk system.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const revenue = await intercardService.getRevenueForDateRange(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(revenue, null, 2) }] };
  })
);

server.tool(
  "get_processing_fees",
  "Get credit card processing fee breakdown: initial fees charged, cost-plus reimbursements, third-party fees, and net processing cost. Note: reimbursements may lag 1-2 business days.",
  dateRangeParam,
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const fees = await payoutService.getProcessingFees(dateRange, startDate, endDate);
    return { content: [{ type: "text" as const, text: JSON.stringify(fees, null, 2) }] };
  })
);

server.tool(
  "get_refunds_list",
  "Get a list of individual refund records for a date range. Each record includes amount, status, reason (if a return), and timestamp. Refunds with no reason are pure refunds; refunds with a reason are returns (e.g., 'Accidental Charge').",
  {
    ...dateRangeParam,
    limit: z.number().int().min(1).max(200).default(50).describe("Max refund records to return (1-200, default 50)"),
  },
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    const refundList = await db
      .execute<{ id: number; amount: number; status: string; reason: string | null; created_at: string; square_payment_id: string }>(sql`
        SELECT id, amount, status, reason, created_at, square_payment_id
        FROM ${refunds} WHERE created_at BETWEEN ${start} AND ${end}
        ORDER BY created_at DESC LIMIT ${params.limit}
      `)
      .then((r) => r.rows);
    return { content: [{ type: "text" as const, text: JSON.stringify(refundList, null, 2) }] };
  })
);

server.tool(
  "get_sync_status",
  "Check the current data synchronization status. Shows when each data type (payments, orders, gift cards, refunds) was last synced and whether syncs are running.",
  {},
  async () => safeTool(async () => {
    const { desc } = await import("drizzle-orm");
    const rows = await db.select().from(syncState).orderBy(desc(syncState.lastSyncedAt));
    const status = rows.map((r) => ({
      syncType: r.syncType, lastSyncedAt: r.lastSyncedAt, status: r.status,
      processedCount: r.processedCount, isComplete: r.isComplete,
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
  })
);

server.tool(
  "get_database_stats",
  "Get record counts for all major database tables: orders, transactions, gift cards, refunds, intercard revenue entries, and payout fee entries. Useful for understanding data coverage.",
  {},
  async () => safeTool(async () => {
    const counts = await db
      .execute<{ table_name: string; row_count: number }>(sql`
        SELECT 'orders' AS table_name, COUNT(*)::integer AS row_count FROM orders
        UNION ALL SELECT 'transactions', COUNT(*)::integer FROM transactions
        UNION ALL SELECT 'gift_cards', COUNT(*)::integer FROM gift_cards
        UNION ALL SELECT 'refunds', COUNT(*)::integer FROM refunds
        UNION ALL SELECT 'intercard_revenue', COUNT(*)::integer FROM intercard_revenue
        UNION ALL SELECT 'payout_fee_entries', COUNT(*)::integer FROM payout_fee_entries
        UNION ALL SELECT 'order_line_items', COUNT(*)::integer FROM order_line_items
      `)
      .then((r) => r.rows);
    return { content: [{ type: "text" as const, text: JSON.stringify(counts, null, 2) }] };
  })
);

server.tool(
  "query_orders",
  "Search and filter orders with flexible criteria. Returns order details including total, tax, discount, source, and status.",
  {
    ...dateRangeParam,
    source: z.string().optional().describe("Filter by order source (e.g., 'Web Reservation', 'Terminal', 'Web Reservation-Attraction')"),
    status: z.string().optional().describe("Filter by order status (e.g., 'COMPLETED', 'CANCELED')"),
    minTotal: z.number().min(0).optional().describe("Minimum order total in dollars"),
    limit: z.number().int().min(1).max(200).default(50).describe("Max orders to return (1-200, default 50)"),
  },
  async (params) => safeTool(async () => {
    const { dateRange, startDate, endDate } = parseDates(params);
    const { start, end } = getEasternDateRange(dateRange, startDate, endDate);
    let query = sql`
      SELECT id, square_id, status, total_money, total_tax, total_discount, created_at, source
      FROM orders WHERE created_at BETWEEN ${start} AND ${end}
    `;
    if (params.source) query = sql`${query} AND source = ${params.source}`;
    if (params.status) query = sql`${query} AND status = ${params.status}`;
    if (params.minTotal !== undefined) query = sql`${query} AND total_money >= ${params.minTotal}`;
    query = sql`${query} ORDER BY created_at DESC LIMIT ${params.limit}`;
    const result = await db.execute(query).then((r) => r.rows);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  })
);

server.tool(
  "compare_periods",
  "Compare key metrics between two date ranges side by side. Great for week-over-week, month-over-month, or year-over-year analysis. Returns revenue, orders, average order value, and gift card sales for both periods with percentage changes.",
  {
    period1Start: z.string().describe("First period start date (YYYY-MM-DD)"),
    period1End: z.string().describe("First period end date (YYYY-MM-DD)"),
    period2Start: z.string().describe("Second period start date (YYYY-MM-DD)"),
    period2End: z.string().describe("Second period end date (YYYY-MM-DD)"),
  },
  async (params) => safeTool(async () => {
    const p1Start = parseAndValidateDate(params.period1Start);
    const p1End = parseAndValidateDate(params.period1End);
    const p2Start = parseAndValidateDate(params.period2Start);
    const p2End = parseAndValidateDate(params.period2End);
    if (p1Start > p1End) throw new Error("period1Start must be before period1End");
    if (p2Start > p2End) throw new Error("period2Start must be before period2End");

    const [summary1, summary2] = await Promise.all([
      dashboardService.getDailySummary("custom", p1Start, p1End),
      dashboardService.getDailySummary("custom", p2Start, p2End),
    ]);

    const pctChange = (a: number, b: number) => b > 0 ? ((a - b) / b) * 100 : 0;

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          period1: {
            dates: `${params.period1Start} to ${params.period1End}`,
            totalRevenue: summary1.totalRevenue, grossPayments: summary1.grossPayments,
            totalOrders: summary1.totalOrders, averageOrder: summary1.averageOrder,
            giftCardSales: summary1.giftCardSales, refunds: summary1.refunds, returns: summary1.returns,
          },
          period2: {
            dates: `${params.period2Start} to ${params.period2End}`,
            totalRevenue: summary2.totalRevenue, grossPayments: summary2.grossPayments,
            totalOrders: summary2.totalOrders, averageOrder: summary2.averageOrder,
            giftCardSales: summary2.giftCardSales, refunds: summary2.refunds, returns: summary2.returns,
          },
          changes: {
            revenueChange: `${pctChange(summary1.totalRevenue, summary2.totalRevenue).toFixed(1)}%`,
            ordersChange: `${pctChange(summary1.totalOrders, summary2.totalOrders).toFixed(1)}%`,
            avgOrderChange: `${pctChange(summary1.averageOrder, summary2.averageOrder).toFixed(1)}%`,
            giftCardSalesChange: `${pctChange(summary1.giftCardSales, summary2.giftCardSales).toFixed(1)}%`,
          },
        }, null, 2),
      }],
    };
  })
);

server.tool(
  "get_daily_revenue_trend",
  "Get daily revenue totals for a date range. Returns an array of { date, revenue } entries for charting or trend analysis. Useful for spotting patterns over weeks or months.",
  {
    startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    endDate: z.string().describe("End date (YYYY-MM-DD)"),
  },
  async (params) => safeTool(async () => {
    const start = parseAndValidateDate(params.startDate);
    const end = parseAndValidateDate(params.endDate);
    if (start > end) throw new Error("startDate must be before endDate");
    const { start: utcStart, end: utcEnd } = getEasternDateRange("custom", start, end);

    const dailyRevenue = await db
      .execute<{ day: string; revenue: number }>(sql`
        SELECT to_char(timestamp AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS day,
               SUM(amount)::numeric AS revenue
        FROM ${transactions}
        WHERE timestamp BETWEEN ${utcStart} AND ${utcEnd} AND status = 'completed'
        GROUP BY day ORDER BY day
      `)
      .then((r) => r.rows);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(dailyRevenue.map((d) => ({ date: d.day, revenue: Number(d.revenue) })), null, 2),
      }],
    };
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Perfect Game MCP server running on stdio");
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
