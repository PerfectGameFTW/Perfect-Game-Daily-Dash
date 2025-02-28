import { db } from "./db";
import { transactions, giftCards, giftCardRedemptions } from "@shared/schema";
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { sql } from 'drizzle-orm';
import dotenv from 'dotenv';

const EASTERN_TIMEZONE = 'America/New_York';

async function backupTables() {
  console.log('Creating backup tables...');
  
  try {
    // Create backup tables with current data
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS transactions_backup AS 
      SELECT * FROM transactions;
      
      CREATE TABLE IF NOT EXISTS gift_cards_backup AS 
      SELECT * FROM gift_cards;
      
      CREATE TABLE IF NOT EXISTS gift_card_redemptions_backup AS 
      SELECT * FROM gift_card_redemptions;
    `);
    
    console.log('✅ Backup tables created successfully');
    return true;
  } catch (error) {
    console.error('Error creating backup tables:', error);
    return false;
  }
}

async function updateTransactionTimestamps() {
  console.log('Updating transaction timestamps to Eastern Time...');
  let processed = 0;
  
  try {
    // Get all transactions
    const allTransactions = await db.select().from(transactions);
    console.log(`Found ${allTransactions.length} transactions to process`);
    
    for (const transaction of allTransactions) {
      // Convert UTC timestamp to Eastern Time
      const utcDate = new Date(transaction.timestamp);
      const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);
      
      // Update the transaction
      await db.update(transactions)
        .set({ timestamp: easternDate })
        .where(sql`id = ${transaction.id}`);
      
      processed++;
      if (processed % 100 === 0) {
        console.log(`Processed ${processed} transactions`);
      }
    }
    
    console.log(`✅ Updated ${processed} transaction timestamps`);
    return true;
  } catch (error) {
    console.error('Error updating transaction timestamps:', error);
    return false;
  }
}

async function updateGiftCardTimestamps() {
  console.log('Updating gift card timestamps to Eastern Time...');
  let processed = 0;
  
  try {
    // Get all gift cards
    const allGiftCards = await db.select().from(giftCards);
    console.log(`Found ${allGiftCards.length} gift cards to process`);
    
    for (const giftCard of allGiftCards) {
      // Convert UTC timestamp to Eastern Time
      const utcDate = new Date(giftCard.purchaseDate);
      const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);
      
      // Update the gift card
      await db.update(giftCards)
        .set({ purchaseDate: easternDate })
        .where(sql`id = ${giftCard.id}`);
      
      processed++;
      if (processed % 100 === 0) {
        console.log(`Processed ${processed} gift cards`);
      }
    }
    
    console.log(`✅ Updated ${processed} gift card timestamps`);
    return true;
  } catch (error) {
    console.error('Error updating gift card timestamps:', error);
    return false;
  }
}

async function updateRedemptionTimestamps() {
  console.log('Updating redemption timestamps to Eastern Time...');
  let processed = 0;
  
  try {
    // Get all redemptions
    const allRedemptions = await db.select().from(giftCardRedemptions);
    console.log(`Found ${allRedemptions.length} redemptions to process`);
    
    for (const redemption of allRedemptions) {
      // Convert UTC timestamp to Eastern Time
      const utcDate = new Date(redemption.timestamp);
      const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);
      
      // Update the redemption
      await db.update(giftCardRedemptions)
        .set({ timestamp: easternDate })
        .where(sql`id = ${redemption.id}`);
      
      processed++;
      if (processed % 100 === 0) {
        console.log(`Processed ${processed} redemptions`);
      }
    }
    
    console.log(`✅ Updated ${processed} redemption timestamps`);
    return true;
  } catch (error) {
    console.error('Error updating redemption timestamps:', error);
    return false;
  }
}

async function verifyMigration() {
  console.log('Verifying migration results...');
  
  try {
    // Sample checks from each table
    const sampleTransaction = await db.select()
      .from(transactions)
      .limit(1);
    
    const sampleGiftCard = await db.select()
      .from(giftCards)
      .limit(1);
    
    if (sampleTransaction.length > 0) {
      console.log('Sample transaction timestamp:', 
        formatInTimeZone(sampleTransaction[0].timestamp, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'));
    }
    
    if (sampleGiftCard.length > 0) {
      console.log('Sample gift card timestamp:', 
        formatInTimeZone(sampleGiftCard[0].purchaseDate, EASTERN_TIMEZONE, 'yyyy-MM-dd HH:mm:ss zzz'));
    }
    
    console.log('✅ Migration verification complete');
    return true;
  } catch (error) {
    console.error('Error verifying migration:', error);
    return false;
  }
}

async function runMigration() {
  console.log('Starting timestamp migration to Eastern Time...');
  
  // Create backup tables first
  if (!await backupTables()) {
    console.error('❌ Failed to create backup tables. Migration aborted.');
    return false;
  }
  
  // Update timestamps in all tables
  const results = await Promise.all([
    updateTransactionTimestamps(),
    updateGiftCardTimestamps(),
    updateRedemptionTimestamps()
  ]);
  
  if (results.every(result => result)) {
    console.log('✅ All timestamps successfully updated to Eastern Time');
    
    // Verify the migration
    if (await verifyMigration()) {
      console.log('🎉 Migration completed successfully!');
      return true;
    }
  }
  
  console.error('❌ Migration failed. Use backup tables to restore data if needed.');
  return false;
}

// Only run if this file is executed directly
if (require.main === module) {
  runMigration().catch(console.error);
}
