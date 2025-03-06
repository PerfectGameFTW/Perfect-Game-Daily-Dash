/**
 * Payment Service
 * 
 * Handles business logic related to payment management
 * Provides a clean interface between API routes and storage layer
 */
import { 
  Payment, InsertPayment, PaymentSource, InsertPaymentSource,
  DateRange, TransactionStatus
} from '../schema';
import { IStorage } from '../storage';
import { getDateRangeBoundaries } from '../dateUtils';

export class PaymentError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'PaymentError';
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor(paymentId: string | number) {
    super(`Payment not found: ${paymentId}`, 'PAYMENT_NOT_FOUND');
  }
}

export class InvalidPaymentDataError extends PaymentError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_PAYMENT_DATA', details);
  }
}

export class PaymentService {
  constructor(private storage: IStorage) {}

  /**
   * Get a payment by ID
   */
  async getPayment(paymentId: number): Promise<Payment> {
    const payment = await this.storage.getPayment(paymentId);
    
    if (!payment) {
      throw new PaymentNotFoundError(paymentId);
    }
    
    return payment;
  }
  
  /**
   * Get a payment by Square ID
   */
  async getPaymentBySquareId(squareId: string): Promise<Payment> {
    const payment = await this.storage.getPaymentBySquareId(squareId);
    
    if (!payment) {
      throw new PaymentNotFoundError(squareId);
    }
    
    return payment;
  }
  
  /**
   * Create a payment with its source
   */
  async createPaymentWithSource(
    payment: InsertPayment,
    source?: InsertPaymentSource
  ): Promise<Payment> {
    // Basic validation
    if (!payment.squareId || !payment.status) {
      throw new InvalidPaymentDataError('Payment requires squareId and status');
    }
    
    try {
      // Create payment source if provided
      let sourceId: number | undefined;
      
      if (source && source.squareId) {
        // Check if source already exists
        const existingSource = await this.storage.getPaymentSourceBySquareId(source.squareId);
        
        if (existingSource) {
          sourceId = existingSource.id;
        } else {
          // Create new payment source
          const createdSource = await this.storage.createPaymentSource(source);
          sourceId = createdSource.id;
        }
      }
      
      // Create the payment
      const createdPayment = await this.storage.createPayment({
        ...payment,
        sourceId
      });
      
      return createdPayment;
    } catch (error) {
      // Log the error
      console.error('Failed to create payment:', error);
      
      // Rethrow with appropriate error class
      if (error instanceof PaymentError) {
        throw error;
      }
      
      throw new PaymentError(
        'Failed to create payment',
        'PAYMENT_CREATION_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  
  /**
   * Get payments by date range
   */
  async getPaymentsByDateRange(
    dateRange: DateRange,
    startDate?: Date,
    endDate?: Date,
    status?: TransactionStatus
  ): Promise<Payment[]> {
    // Normalize date range
    const { start, end } = getDateRangeBoundaries(dateRange, startDate, endDate);
    
    // Delegate to storage layer
    return this.storage.listPaymentsByDateRange(dateRange, start, end, status);
  }
  
  /**
   * Process a refund for a payment
   */
  async processRefund(paymentId: number, amount: number, reason?: string): Promise<Payment> {
    const payment = await this.getPayment(paymentId);
    
    if (payment.status === 'refunded') {
      throw new PaymentError('Payment already refunded', 'ALREADY_REFUNDED');
    }
    
    if (amount <= 0 || amount > payment.amount) {
      throw new InvalidPaymentDataError(`Invalid refund amount: ${amount}`, {
        requestedAmount: amount,
        paymentAmount: payment.amount
      });
    }
    
    // Update payment status
    const updatedPayment = await this.storage.updatePayment(paymentId, {
      status: 'refunded',
      metadata: {
        ...payment.metadata,
        refundReason: reason || 'No reason provided',
        refundAmount: amount,
        refundTimestamp: new Date().toISOString()
      }
    });
    
    return updatedPayment;
  }
}