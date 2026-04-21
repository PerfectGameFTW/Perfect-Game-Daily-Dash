/**
 * Centralized error class hierarchy and client-facing error sanitizer.
 *
 * Every error class the application throws on purpose extends `AppError`,
 * which carries:
 *
 *   - `statusCode` — the HTTP status the route layer should send.
 *   - `code`       — a stable machine-readable code for the client.
 *   - `details`    — optional structured context (validation issues, etc.).
 *
 * The route layer calls `toSafeErrorResponse(err)` (or the convenience
 * `sendError(res, err)`) to get both the status code and a sanitized JSON
 * body in one shot. Anything that is NOT an `AppError` (Square SDK errors,
 * Postgres errors, generic `Error`s, etc.) collapses to a 500 with a
 * generic message so we never leak stack traces, file paths, or upstream
 * library internals. ZodError is special-cased and surfaces as a 400.
 *
 * Domain-specific subclasses (OrderError, PaymentError, GiftCardError,
 * SyncError, AuthError) live here too rather than in their respective
 * service files so that:
 *   - There is exactly one source of truth.
 *   - Routes can `instanceof` check them without circular imports.
 *   - The sanitizer is the only place that decides what's safe to surface.
 *
 * The service files re-export the names they used to define locally so
 * existing `import { OrderError } from './orderService'` keeps working.
 *
 * # Convention for new route handlers
 *
 * Don't write `res.status(400).json({ error: '...' })` — throw a typed
 * AppError subclass instead and let the centralized sanitizer pick the
 * status code:
 *
 *     throw new ValidationError('startDate must be before endDate');
 *     throw new UnauthorizedError();
 *     throw new ConflictError('Email already in use');
 *
 * In an Express handler with a `next` parameter, just `throw` from an
 * async handler (Express 5) or `next(err)` (Express 4) and the global
 * error middleware in `server/index.ts` will sanitize. In the rare
 * handler without a `next` (e.g. inside a synchronous callback like
 * `req.session.destroy`), call `sendError(res, err)` directly.
 */

import type { Response } from 'express';
import { ZodError } from 'zod';

// ---------------------------------------------------------------------------
// Public response shape
// ---------------------------------------------------------------------------

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: unknown;
}

export interface SafeErrorResult {
  status: number;
  body: ErrorResponse;
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
  details?: unknown;
  expose?: boolean;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  /**
   * Whether this error's `message` is safe to send to clients verbatim.
   * Defaults to true for everything that extends AppError (the whole point
   * of this hierarchy is that messages are author-controlled and reviewed),
   * but can be flipped off for sub-classes that wrap upstream errors.
   */
  public readonly expose: boolean;

  constructor(message: string, opts: AppErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.statusCode = opts.statusCode ?? 500;
    this.code = opts.code ?? 'INTERNAL_ERROR';
    this.details = opts.details;
    this.expose = opts.expose ?? true;
  }
}

// ---------------------------------------------------------------------------
// Generic HTTP-shaped subclasses
// ---------------------------------------------------------------------------

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, { statusCode: 401, code: 'UNAUTHORIZED' });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { statusCode: 403, code: 'FORBIDDEN' });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { statusCode: 404, code: 'NOT_FOUND' });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { statusCode: 409, code: 'CONFLICT', details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable') {
    super(message, { statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  }
}

export interface ExternalServiceErrorOptions {
  /**
   * Stable machine-readable code identifying the specific upstream
   * failure (e.g. 'SQUARE_TOKEN_NOT_CONFIGURED', 'SQUARE_SYNC_TIMEOUT').
   * Defaults to 'EXTERNAL_SERVICE_ERROR' for callers that don't care.
   */
  code?: string;
  details?: unknown;
}

export class ExternalServiceError extends AppError {
  constructor(message: string, opts: ExternalServiceErrorOptions = {}) {
    // 502 Bad Gateway: upstream service failed (Square, SendGrid, etc.).
    super(message, {
      statusCode: 502,
      code: opts.code ?? 'EXTERNAL_SERVICE_ERROR',
      details: opts.details,
    });
  }
}

// ---------------------------------------------------------------------------
// Domain-specific subclasses
// ---------------------------------------------------------------------------

export class OrderError extends AppError {
  constructor(message: string, code: string = 'ORDER_ERROR', details?: unknown) {
    super(message, { statusCode: 500, code, details });
  }
}

export class OrderNotFoundError extends OrderError {
  constructor(orderId: string | number) {
    super(`Order with ID ${orderId} not found`, 'ORDER_NOT_FOUND');
    Object.defineProperty(this, 'statusCode', { value: 404, enumerable: true });
  }
}

export class InvalidOrderDataError extends OrderError {
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_ORDER_DATA', details);
    Object.defineProperty(this, 'statusCode', { value: 400, enumerable: true });
  }
}

export class OrderProcessingError extends OrderError {
  constructor(message: string, details?: unknown) {
    super(message, 'ORDER_PROCESSING_ERROR', details);
  }
}

export class PaymentError extends AppError {
  constructor(message: string, code: string = 'PAYMENT_ERROR', details?: unknown) {
    super(message, { statusCode: 500, code, details });
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor(paymentId: string | number) {
    super(`Payment with ID ${paymentId} not found`, 'PAYMENT_NOT_FOUND');
    Object.defineProperty(this, 'statusCode', { value: 404, enumerable: true });
  }
}

export class InvalidPaymentDataError extends PaymentError {
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_PAYMENT_DATA', details);
    Object.defineProperty(this, 'statusCode', { value: 400, enumerable: true });
  }
}

export class GiftCardError extends AppError {
  constructor(message: string, code: string = 'GIFT_CARD_ERROR', details?: unknown) {
    super(message, { statusCode: 500, code, details });
  }
}

export class GiftCardNotFoundError extends GiftCardError {
  constructor(giftCardId: string | number) {
    super(`Gift card with ID ${giftCardId} not found`, 'GIFT_CARD_NOT_FOUND');
    Object.defineProperty(this, 'statusCode', { value: 404, enumerable: true });
  }
}

export class InsufficientBalanceError extends GiftCardError {
  constructor(
    giftCardId: string | number,
    requestedAmount: number,
    currentBalance: number,
  ) {
    super(
      `Gift card ${giftCardId} has insufficient balance. Requested: ${requestedAmount}, Available: ${currentBalance}`,
      'INSUFFICIENT_BALANCE',
      { requestedAmount, currentBalance },
    );
    Object.defineProperty(this, 'statusCode', { value: 409, enumerable: true });
  }
}

export class SyncError extends AppError {
  constructor(message: string, code: string = 'SYNC_ERROR', details?: unknown) {
    super(message, { statusCode: 500, code, details });
  }
}

/**
 * Authentication / authorization domain error. Default status is 400 because
 * most call-sites use this for invalid-input style failures
 * (e.g. "username already exists"). Specific call-sites that mean 401/403/409
 * should prefer UnauthorizedError / ForbiddenError / ConflictError instead.
 */
export class AuthError extends AppError {
  constructor(message: string, statusCode = 400, code: string = 'AUTH_ERROR') {
    super(message, { statusCode, code });
  }
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

const GENERIC_MESSAGE = 'An unexpected error occurred';

/**
 * Convert any thrown value into `{ status, body }` for the route layer.
 *
 *   - `AppError` (and subclasses) → its own statusCode + safe message + code
 *                                   (+ details if present).
 *   - `ZodError`                  → 400 + 'Invalid input' + the zod issue
 *                                   tree as `details`. This catches the
 *                                   common pattern of `schema.parse()`
 *                                   throwing inside a route handler.
 *   - Anything else               → 500 + generic message, no leaked details.
 *
 * Server-side logging (full stack, full message) happens elsewhere — this
 * function deliberately discards everything that isn't pre-blessed.
 */
export function toSafeErrorResponse(error: unknown): SafeErrorResult {
  if (error instanceof AppError && error.expose) {
    const body: ErrorResponse = { error: error.message };
    if (error.code) body.code = error.code;
    if (error.details !== undefined) body.details = error.details;
    return { status: error.statusCode, body };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'Invalid input',
        code: 'VALIDATION_ERROR',
        details: error.format(),
      },
    };
  }
  // AppError with expose=false (or any other Error / non-Error) → generic.
  const status =
    error instanceof AppError && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
  return { status, body: { error: GENERIC_MESSAGE } };
}

/**
 * Convenience wrapper for the common pattern of:
 *
 *     const { status, body } = toSafeErrorResponse(err);
 *     res.status(status).json(body);
 *
 * Use this from any handler that doesn't want to (or can't) defer to the
 * global Express error middleware — e.g. legacy callbacks or the MCP
 * transport layer where there's no `next` to call.
 */
export function sendError(res: Response, error: unknown): Response {
  const { status, body } = toSafeErrorResponse(error);
  return res.status(status).json(body);
}

/**
 * Backwards-compatible adapter for callers that only want the JSON body.
 * New code should prefer `toSafeErrorResponse` (or `sendError`) so the
 * status code is applied automatically.
 */
export function toErrorResponse(error: unknown): ErrorResponse {
  return toSafeErrorResponse(error).body;
}
