import { 
  Transaction, InsertTransaction, 
  GiftCard, InsertGiftCard, 
  GiftCardRedemption, InsertGiftCardRedemption,
  User, InsertUser,
  DailySummary, CategoryRevenue, HourlyRevenue, GiftCardSummary,
  DateRange
} from "@shared/schema";
import { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } from "date-fns";

export interface IStorage {
  // User methods (keeping from original)
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Transaction methods
  getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<Transaction[]>;
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
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private transactions: Map<number, Transaction>;
  private giftCards: Map<number, GiftCard>;
  private giftCardRedemptions: Map<number, GiftCardRedemption>;
  
  private transactionCurrentId: number;
  private giftCardCurrentId: number;
  private giftCardRedemptionCurrentId: number;
  private userCurrentId: number;

  constructor() {
    this.users = new Map();
    this.transactions = new Map();
    this.giftCards = new Map();
    this.giftCardRedemptions = new Map();
    
    this.transactionCurrentId = 1;
    this.giftCardCurrentId = 1;
    this.giftCardRedemptionCurrentId = 1;
    this.userCurrentId = 1;
    
    // Add some sample data for testing
    this.initSampleData();
  }

  // User methods (keeping from original)
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.userCurrentId++;
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  // Transaction methods
  async getTransactions(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<Transaction[]> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    return Array.from(this.transactions.values()).filter(transaction => {
      const transactionDate = new Date(transaction.timestamp);
      return transactionDate >= start && transactionDate <= end;
    }).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  async getTransactionById(id: number): Promise<Transaction | undefined> {
    return this.transactions.get(id);
  }

  async getTransactionBySquareId(squareId: string): Promise<Transaction | undefined> {
    return Array.from(this.transactions.values()).find(
      (transaction) => transaction.squareId === squareId,
    );
  }

  async createTransaction(insertTransaction: InsertTransaction): Promise<Transaction> {
    const id = this.transactionCurrentId++;
    const transaction: Transaction = { 
      ...insertTransaction, 
      id,
      squareData: insertTransaction.squareData || {} 
    };
    this.transactions.set(id, transaction);
    return transaction;
  }

  // Gift card methods
  async getGiftCards(): Promise<GiftCard[]> {
    return Array.from(this.giftCards.values());
  }

  async getGiftCardById(id: number): Promise<GiftCard | undefined> {
    return this.giftCards.get(id);
  }

  async getGiftCardBySquareId(squareId: string): Promise<GiftCard | undefined> {
    return Array.from(this.giftCards.values()).find(
      (giftCard) => giftCard.squareId === squareId,
    );
  }

  async createGiftCard(insertGiftCard: InsertGiftCard): Promise<GiftCard> {
    const id = this.giftCardCurrentId++;
    const giftCard: GiftCard = { 
      ...insertGiftCard, 
      id,
      squareData: insertGiftCard.squareData || {},
      redeemedAmount: insertGiftCard.redeemedAmount || 0,
      isActive: insertGiftCard.isActive !== undefined ? insertGiftCard.isActive : true
    };
    this.giftCards.set(id, giftCard);
    return giftCard;
  }

  async updateGiftCardRedemption(id: number, amount: number): Promise<GiftCard> {
    const giftCard = this.giftCards.get(id);
    if (!giftCard) {
      throw new Error(`Gift card with id ${id} not found`);
    }
    
    const updatedGiftCard: GiftCard = {
      ...giftCard,
      redeemedAmount: giftCard.redeemedAmount + amount,
    };
    
    this.giftCards.set(id, updatedGiftCard);
    return updatedGiftCard;
  }

  // Gift card redemption methods
  async createGiftCardRedemption(insertRedemption: InsertGiftCardRedemption): Promise<GiftCardRedemption> {
    const id = this.giftCardRedemptionCurrentId++;
    const redemption: GiftCardRedemption = { ...insertRedemption, id };
    this.giftCardRedemptions.set(id, redemption);
    
    // Update the gift card's redeemed amount
    await this.updateGiftCardRedemption(redemption.giftCardId, redemption.amount);
    
    return redemption;
  }

  async getGiftCardRedemptions(giftCardId: number): Promise<GiftCardRedemption[]> {
    return Array.from(this.giftCardRedemptions.values())
      .filter(redemption => redemption.giftCardId === giftCardId)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }

  // Dashboard summary methods
  async getDailySummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<DailySummary> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    const prevStart = new Date(start);
    prevStart.setDate(prevStart.getDate() - (end.getDate() - start.getDate() + 1));
    const prevEnd = new Date(end);
    prevEnd.setDate(prevEnd.getDate() - (end.getDate() - start.getDate() + 1));
    
    // Current period transactions
    const transactions = await this.getTransactions(dateRange, start, end);
    
    // Previous period transactions (for change calculations)
    const prevTransactions = Array.from(this.transactions.values()).filter(transaction => {
      const transactionDate = new Date(transaction.timestamp);
      return transactionDate >= prevStart && transactionDate <= prevEnd;
    });
    
    // Calculate current period metrics
    const totalRevenue = transactions.reduce((sum, t) => sum + t.amount, 0);
    const totalOrders = transactions.length;
    const averageOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    
    // Gift card sales
    const giftCardSales = transactions
      .filter(t => t.categoryId === 'giftCard')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Calculate previous period metrics for change percentages
    const prevTotalRevenue = prevTransactions.reduce((sum, t) => sum + t.amount, 0);
    const prevTotalOrders = prevTransactions.length;
    const prevAverageOrder = prevTotalOrders > 0 ? prevTotalRevenue / prevTotalOrders : 0;
    const prevGiftCardSales = prevTransactions
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
    
    const transactions = await this.getTransactions(dateRange, start, end);
    
    // Define category colors matching the design
    const categoryColors: Record<string, string> = {
      food: '#3B82F6',
      drinks: '#6366F1',
      retail: '#8B5CF6',
      services: '#10B981',
      giftCard: '#F59E0B'
    };
    
    // Group by category and calculate totals
    const categoryMap = new Map<string, number>();
    
    transactions.forEach(transaction => {
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
    
    const transactions = await this.getTransactions(dateRange, start, end);
    
    // Initialize hourly buckets (9 AM to 5 PM)
    const hourlyMap = new Map<string, number>();
    
    for (let hour = 9; hour <= 17; hour++) {
      const formattedHour = hour > 12 ? `${hour - 12} PM` : hour === 12 ? '12 PM' : `${hour} AM`;
      hourlyMap.set(formattedHour, 0);
    }
    
    // Group transactions by hour
    transactions.forEach(transaction => {
      const date = new Date(transaction.timestamp);
      const hour = date.getHours();
      if (hour >= 9 && hour <= 17) {
        const formattedHour = hour > 12 ? `${hour - 12} PM` : hour === 12 ? '12 PM' : `${hour} AM`;
        const currentAmount = hourlyMap.get(formattedHour) || 0;
        hourlyMap.set(formattedHour, currentAmount + transaction.amount);
      }
    });
    
    // Format the result, maintaining the 9 AM to 5 PM order
    return Array.from(hourlyMap.entries()).map(([hour, amount]) => ({
      hour,
      amount
    }));
  }

  async getGiftCardSummary(dateRange: DateRange, startDate?: Date, endDate?: Date): Promise<GiftCardSummary> {
    const { start, end } = this.getDateRange(dateRange, startDate, endDate);
    
    const transactions = await this.getTransactions(dateRange, start, end);
    const redemptions = Array.from(this.giftCardRedemptions.values()).filter(redemption => {
      const redemptionDate = new Date(redemption.timestamp);
      return redemptionDate >= start && redemptionDate <= end;
    });
    
    // Gift card sales
    const giftCardTransactions = transactions.filter(t => t.categoryId === 'giftCard');
    const soldCount = giftCardTransactions.length;
    const soldAmount = giftCardTransactions.reduce((sum, t) => sum + t.amount, 0);
    
    // Gift card redemptions
    const redeemedCount = redemptions.length;
    const redeemedAmount = redemptions.reduce((sum, r) => sum + r.amount, 0);
    
    // Average gift card value
    const averageValue = soldCount > 0 ? soldAmount / soldCount : 0;
    
    return {
      soldCount,
      soldAmount,
      redeemedCount,
      redeemedAmount,
      averageValue
    };
  }
  
  // Helper method for date range calculations
  private getDateRange(dateRange: DateRange, startDate?: Date, endDate?: Date): { start: Date; end: Date } {
    let start: Date;
    let end: Date;
    
    const now = new Date();
    
    switch (dateRange) {
      case 'today':
        start = startOfDay(now);
        end = endOfDay(now);
        break;
      case 'yesterday':
        start = startOfDay(subDays(now, 1));
        end = endOfDay(subDays(now, 1));
        break;
      case 'last7days':
        start = startOfDay(subDays(now, 6));
        end = endOfDay(now);
        break;
      case 'last30days':
        start = startOfDay(subDays(now, 29));
        end = endOfDay(now);
        break;
      case 'thisMonth':
        start = startOfMonth(now);
        end = endOfMonth(now);
        break;
      case 'lastMonth':
        const lastMonth = subDays(startOfMonth(now), 1);
        start = startOfMonth(lastMonth);
        end = endOfMonth(lastMonth);
        break;
      case 'custom':
        if (!startDate || !endDate) {
          throw new Error('Start date and end date must be provided for custom date range');
        }
        start = startOfDay(startDate);
        end = endOfDay(endDate);
        break;
      default:
        start = startOfDay(now);
        end = endOfDay(now);
    }
    
    return { start, end };
  }

  // Initialize with sample data for testing
  private initSampleData() {
    const today = new Date();
    const yesterday = subDays(today, 1);
    
    // Sample transactions from the design mockup
    const sampleTransactions: InsertTransaction[] = [
      {
        squareId: 'sq_t_1',
        amount: 84.3,
        categoryId: 'food',
        status: 'completed',
        timestamp: new Date(today.setHours(15, 45, 0, 0)),
        squareData: {}
      },
      {
        squareId: 'sq_t_2',
        amount: 35.4,
        categoryId: 'drinks',
        status: 'completed',
        timestamp: new Date(today.setHours(15, 22, 0, 0)),
        squareData: {}
      },
      {
        squareId: 'sq_t_3',
        amount: 42.75,
        categoryId: 'retail',
        status: 'completed',
        timestamp: new Date(today.setHours(14, 50, 0, 0)),
        squareData: {}
      },
      {
        squareId: 'sq_t_4',
        amount: 50.0,
        categoryId: 'giftCard',
        status: 'completed',
        timestamp: new Date(today.setHours(14, 15, 0, 0)),
        squareData: {}
      },
      {
        squareId: 'sq_t_5',
        amount: 22.5,
        categoryId: 'food',
        status: 'completed',
        timestamp: new Date(today.setHours(13, 45, 0, 0)),
        squareData: {}
      }
    ];
    
    // Add additional data for each hour to match the charts
    const hourlyAmounts = [245.5, 350.3, 525.75, 725.9, 625.15, 575.2, 615.8, 455.25, 266.39];
    for (let hour = 9; hour <= 17; hour++) {
      if (!sampleTransactions.find(t => new Date(t.timestamp).getHours() === hour)) {
        const hourAmount = hourlyAmounts[hour - 9];
        sampleTransactions.push({
          squareId: `sq_t_hour_${hour}`,
          amount: hourAmount / 2, // Split into two transactions
          categoryId: hour % 2 === 0 ? 'food' : 'drinks',
          status: 'completed',
          timestamp: new Date(today.setHours(hour, Math.floor(Math.random() * 59), 0, 0)),
          squareData: {}
        });
        sampleTransactions.push({
          squareId: `sq_t_hour_${hour}_2`,
          amount: hourAmount / 2,
          categoryId: hour % 3 === 0 ? 'retail' : 'food',
          status: 'completed',
          timestamp: new Date(today.setHours(hour, Math.floor(Math.random() * 59), 0, 0)),
          squareData: {}
        });
      }
    }
    
    // Add more gift card transactions to match the total in the design
    for (let i = 0; i < 11; i++) { // Adding 11 more for a total of 12
      sampleTransactions.push({
        squareId: `sq_t_gift_${i}`,
        amount: 50 + Math.floor(Math.random() * 50), // Random amount between 50-100
        categoryId: 'giftCard',
        status: 'completed',
        timestamp: new Date(today.setHours(
          9 + Math.floor(Math.random() * 8), 
          Math.floor(Math.random() * 59), 
          0, 
          0
        )),
        squareData: {}
      });
    }
    
    // Insert all transactions
    sampleTransactions.forEach(transaction => {
      const id = this.transactionCurrentId++;
      const fullTransaction: Transaction = { 
        ...transaction, 
        id, 
        squareData: transaction.squareData || {} 
      };
      this.transactions.set(id, fullTransaction);
    });
    
    // Create gift cards
    const giftCardTransactions = Array.from(this.transactions.values())
      .filter(t => t.categoryId === 'giftCard');
    
    giftCardTransactions.forEach(transaction => {
      const id = this.giftCardCurrentId++;
      const giftCard: GiftCard = {
        id,
        squareId: `sq_gc_${id}`,
        amount: transaction.amount,
        redeemedAmount: Math.random() > 0.5 ? transaction.amount * (Math.random() * 0.8) : 0, // Some partially redeemed
        isActive: true,
        purchaseDate: transaction.timestamp,
        squareData: {}
      };
      
      this.giftCards.set(id, giftCard);
      
      // Add redemption records for redeemed gift cards
      if (giftCard.redeemedAmount > 0) {
        const redemptionId = this.giftCardRedemptionCurrentId++;
        const redemption: GiftCardRedemption = {
          id: redemptionId,
          giftCardId: giftCard.id,
          amount: giftCard.redeemedAmount,
          transactionId: transaction.id, // Just for sample data
          timestamp: new Date(transaction.timestamp.getTime() + Math.random() * 86400000) // Random time within a day of purchase
        };
        
        this.giftCardRedemptions.set(redemptionId, redemption);
      }
    });
  }
}

export const storage = new MemStorage();
