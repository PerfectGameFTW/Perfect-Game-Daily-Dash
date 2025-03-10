/**
 * Gift Card Fixer API
 * 
 * This module provides the API endpoints for comprehensive gift card fixing
 * that ensures ALL gift cards are properly linked to their original orders
 * and have accurate activation amounts.
 */

import { Request, Response, NextFunction, Router } from 'express';
import { fixAllGiftCardActivationAmounts, analyzeGiftCardLinkingStatus } from '../services/enhancedGiftCardFix';

export const giftCardFixerRouter = Router();

/**
 * Fix ALL gift card activation amounts
 * POST /api/fix-gift-cards
 * 
 * This endpoint provides a comprehensive solution for accurately linking
 * ALL gift cards to their original orders with exact activation amounts.
 * 
 * The implementation:
 * 1. Uses direct Square API integration for both cards and order data
 * 2. Employs multi-stage matching with expanded timeframes
 * 3. Creates permanent links between gift cards and their activation orders
 * 4. Future-proofs through automatic linking during creation
 */
giftCardFixerRouter.post('/fix-gift-cards', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    console.log('Starting comprehensive gift card activation fix...');
    
    // Use the enhanced implementation that fixes ALL gift cards
    const result = await fixAllGiftCardActivationAmounts();
    
    console.log(`Gift card fix complete: ${result.updated} cards updated, ${result.alreadyCorrect} already correct`);
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Error in gift card fix endpoint:', error);
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
    console.log('Analyzing gift card data...');
    
    // Use the enhanced analysis function
    const result = await analyzeGiftCardLinkingStatus();
    
    console.log(`Gift card analysis complete: ${result.totalGiftCards} cards analyzed`);
    
    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('Error in gift card analysis endpoint:', error);
    next(error);
  }
});