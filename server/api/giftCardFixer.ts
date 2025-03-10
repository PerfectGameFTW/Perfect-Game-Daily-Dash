/**
 * Gift Card Fixer API
 * 
 * This module provides the API endpoints for comprehensive gift card fixing
 * that ensures ALL gift cards are properly linked to their original orders
 * and have accurate activation amounts.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { giftCards, transactions, orders } from '@shared/schema';
import { count, eq, isNull, sql } from 'drizzle-orm';
import { 
  analyzeGiftCardLinkingStatus, 
  fixAllGiftCardActivationAmounts,
  fixNewGiftCardActivationAmount
} from '../services/enhancedGiftCardFix';

export const giftCardFixerRouter = Router();

/**
 * Fix ALL gift card activation amounts
 * POST /api/fix-gift-cards
 * 
 * This endpoint provides a comprehensive solution for accurately linking
 * ALL gift cards to their original orders with exact activation amounts.
 */
giftCardFixerRouter.post('/fix-gift-cards', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Call the function that handles the comprehensive gift card fixing
    const result = await fixAllGiftCardActivationAmounts();
    
    res.json({
      success: true,
      message: `Fixed ${result.updated} gift cards. ${result.alreadyCorrect} were already correct.`,
      result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Fix a single gift card's activation amount
 * POST /api/fix-gift-card/:id
 * 
 * This endpoint provides a way to fix a specific gift card's activation amount
 * by linking it to its original order.
 */
giftCardFixerRouter.post('/fix-gift-card/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const giftCardId = parseInt(req.params.id);
    
    if (isNaN(giftCardId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid gift card ID',
        error: 'ID must be a number'
      });
    }
    
    // Call the function that handles fixing a single gift card
    const result = await fixNewGiftCardActivationAmount(giftCardId);
    
    if (result.updated) {
      res.json({
        success: true,
        message: `Successfully fixed gift card #${giftCardId} with activation amount $${result.activationAmount}.`,
        source: result.source,
        result
      });
    } else {
      res.json({
        success: false,
        message: `Could not fix gift card #${giftCardId}: ${result.error || 'Unknown error'}`,
        source: result.source,
        result
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Analyze gift card activation amounts and linking status
 * GET /api/analyze-gift-cards
 * 
 * This endpoint provides detailed information about the current state
 * of gift card activation amounts and order linking.
 */
giftCardFixerRouter.get('/analyze-gift-cards', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Get detailed analysis of gift card status
    const result = await analyzeGiftCardLinkingStatus();
    
    res.json({
      success: true,
      message: `Analysis complete. ${result.withActivationAmount} of ${result.totalGiftCards} gift cards have activation amounts (${result.activationAmountPercentage}%).`,
      result
    });
  } catch (error) {
    next(error);
  }
});