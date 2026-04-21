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

// Error response type for consistent client-facing error payloads.
// Intentionally minimal: no stack traces, file paths, or raw upstream library
// messages. Server-side logs still capture the full error.
export interface ErrorResponse {
  error: string;
  code?: string;
}

// Names of project-authored error classes whose `message` is safe to surface
// to clients. We require an exact match (not a substring/regex) so that
// arbitrary upstream errors with coincidental names (e.g. a third-party
// "InvalidArgumentError") do NOT pass through.
const SAFE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'OrderError',
  'OrderNotFoundError',
  'InvalidOrderDataError',
  'OrderProcessingError',
  'PaymentError',
  'PaymentNotFoundError',
  'InvalidPaymentDataError',
  'GiftCardError',
  'GiftCardNotFoundError',
  'InsufficientBalanceError',
  'AuthError',
  'SyncError',
]);

function isSafeErrorName(name: string | undefined): boolean {
  return !!name && SAFE_ERROR_NAMES.has(name);
}

/**
 * Convert any thrown value into a sanitized client-facing payload.
 * - Known custom errors (OrderError + named validation/not-found errors) keep
 *   their short, user-authored message.
 * - Anything else (Square SDK errors, pg/drizzle errors, generic Errors) is
 *   collapsed to a generic message so we never leak stack traces, filesystem
 *   paths, or upstream library internals.
 */
export function toSafeErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof OrderError) {
    return { error: error.message, code: error.code };
  }
  if (error instanceof Error && isSafeErrorName(error.name)) {
    return { error: error.message };
  }
  return { error: 'An unexpected error occurred' };
}

// Backwards-compatible alias. Prefer `toSafeErrorResponse` in new code.
export function toErrorResponse(error: Error): ErrorResponse {
  return toSafeErrorResponse(error);
}
