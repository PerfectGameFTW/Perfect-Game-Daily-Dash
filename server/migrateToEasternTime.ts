import { db } from "./db";
import { transactions, giftCards, giftCardRedemptions } from "@shared/schema";
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { sql } from 'drizzle-orm';
import dotenv from 'dotenv';

const EASTERN_TIMEZONE = 'America/New_York';
const BATCH_SIZE = 1000;

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

async function getMinMaxIds(tableName: string): Promise<{ minId: number; maxId: number }> {
  try {
    const result = await db.execute(sql`
      SELECT MIN(id) as min_id, MAX(id) as max_id
      FROM ${sql.identifier(tableName)};
    `);
    return {
      minId: Number(result.rows[0]?.min_id) || 0,
      maxId: Number(result.rows[0]?.max_id) || 0
    };
  } catch (error) {
    console.error(`Error getting min/max IDs for ${tableName}:`, error);
    return { minId: 0, maxId: 0 };
  }
}

async function getLastProcessedId(tableName: string): Promise<number> {
  try {
    const result = await db.execute(sql`
      SELECT COALESCE(MAX(last_id), 0) as last_id
      FROM migration_progress
      WHERE table_name = ${tableName};
    `);

    // Get the minimum ID for this table
    const { minId } = await getMinMaxIds(tableName);

    // Use the larger of the saved progress or the minimum ID
    const lastId = Number(result.rows[0]?.last_id) || 0;
    return Math.max(lastId, minId);
  } catch (error) {
    console.error(`Error getting last processed ID for ${tableName}:`, error);
    return 0;
  }
}

async function updateProgress(tableName: string, lastId: number) {
  try {
    await db.execute(sql`
      INSERT INTO migration_progress (table_name, last_id)
      VALUES (${tableName}, ${lastId})
      ON CONFLICT (table_name) DO UPDATE
      SET last_id = ${lastId};
    `);
  } catch (error) {
    console.error(`Error updating progress for ${tableName}:`, error);
  }
}

async function createProgressTable() {
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS migration_progress (
        table_name text PRIMARY KEY,
        last_id integer NOT NULL
      );
    `);
  } catch (error) {
    console.error('Error creating progress table:', error);
  }
}

async function updateTransactionTimestamps() {
  console.log('Updating transaction timestamps to Eastern Time...');
  let processed = 0;

  try {
    const { minId, maxId } = await getMinMaxIds('transactions');
    const lastProcessedId = await getLastProcessedId('transactions');

    console.log(`Processing transactions from ID ${lastProcessedId} to ${maxId} (total range: ${minId}-${maxId})`);

    while (true) {
      // Get next batch of transactions
      const batch = await db.select()
        .from(transactions)
        .where(sql`id > ${lastProcessedId + processed} AND id <= ${maxId}`)
        .limit(BATCH_SIZE);

      if (batch.length === 0) break;

      console.log(`Processing batch of ${batch.length} transactions starting from ID ${lastProcessedId + processed + 1}`);

      for (const transaction of batch) {
        // Convert UTC timestamp to Eastern Time
        const utcDate = new Date(transaction.timestamp);
        const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);

        // Update the transaction
        await db.update(transactions)
          .set({ timestamp: easternDate })
          .where(sql`id = ${transaction.id}`);

        processed++;
      }

      // Update progress
      await updateProgress('transactions', lastProcessedId + processed);
      console.log(`Processed ${processed} total transactions, current ID: ${lastProcessedId + processed}`);
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
    const { minId, maxId } = await getMinMaxIds('gift_cards');
    const lastProcessedId = await getLastProcessedId('gift_cards');

    console.log(`Processing gift cards from ID ${lastProcessedId} to ${maxId} (total range: ${minId}-${maxId})`);

    while (true) {
      // Get next batch of gift cards
      const batch = await db.select()
        .from(giftCards)
        .where(sql`id > ${lastProcessedId + processed} AND id <= ${maxId}`)
        .limit(BATCH_SIZE);

      if (batch.length === 0) break;

      console.log(`Processing batch of ${batch.length} gift cards starting from ID ${lastProcessedId + processed + 1}`);

      for (const giftCard of batch) {
        // Convert UTC timestamp to Eastern Time
        const utcDate = new Date(giftCard.purchaseDate);
        const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);

        // Update the gift card
        await db.update(giftCards)
          .set({ purchaseDate: easternDate })
          .where(sql`id = ${giftCard.id}`);

        processed++;
      }

      // Update progress
      await updateProgress('gift_cards', lastProcessedId + processed);
      console.log(`Processed ${processed} total gift cards, current ID: ${lastProcessedId + processed}`);
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
    const { minId, maxId } = await getMinMaxIds('gift_card_redemptions');
    const lastProcessedId = await getLastProcessedId('gift_card_redemptions');

    console.log(`Processing redemptions from ID ${lastProcessedId} to ${maxId} (total range: ${minId}-${maxId})`);

    while (true) {
      // Get next batch of redemptions
      const batch = await db.select()
        .from(giftCardRedemptions)
        .where(sql`id > ${lastProcessedId + processed} AND id <= ${maxId}`)
        .limit(BATCH_SIZE);

      if (batch.length === 0) break;

      console.log(`Processing batch of ${batch.length} redemptions starting from ID ${lastProcessedId + processed + 1}`);

      for (const redemption of batch) {
        // Convert UTC timestamp to Eastern Time
        const utcDate = new Date(redemption.timestamp);
        const easternDate = toZonedTime(utcDate, EASTERN_TIMEZONE);

        // Update the redemption
        await db.update(giftCardRedemptions)
          .set({ timestamp: easternDate })
          .where(sql`id = ${redemption.id}`);

        processed++;
      }

      // Update progress
      await updateProgress('gift_card_redemptions', lastProcessedId + processed);
      console.log(`Processed ${processed} total redemptions, current ID: ${lastProcessedId + processed}`);
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

  // Create progress tracking table
  await createProgressTable();

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

// ES Module style execution check
if (process.argv[1] === new URL(import.meta.url).pathname) {
  runMigration().catch(console.error);
}