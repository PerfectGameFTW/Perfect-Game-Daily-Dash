// Define custom error types for better error handling
export class OrderError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: any) {
    super(message);
    this.name = 'OrderError';
  }
}

export class InvalidOrderDataError extends OrderError {
  constructor(message: string, details?: any) {
    super(message, 'INVALID_ORDER_DATA', details);
  }
}

export class OrderNotFoundError extends OrderError {
  constructor(orderId: string | number) {
    super(`Order not found: ${orderId}`, 'ORDER_NOT_FOUND');
  }
}

export class OrderProcessingError extends OrderError {
  constructor(message: string, details?: any) {
    super(message, 'ORDER_PROCESSING_ERROR', details);
  }
}

// Error response type for consistent error handling
export interface ErrorResponse {
  error: string;
  message: string;
  code?: string;
  details?: any;
}

// Helper function to convert errors to API responses
export function toErrorResponse(error: Error): ErrorResponse {
  if (error instanceof OrderError) {
    return {
      error: error.name,
      message: error.message,
      code: error.code,
      details: error.details
    };
  }
  
  return {
    error: error.name || 'UnknownError',
    message: error.message || 'An unexpected error occurred'
  };
}
