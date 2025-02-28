import { db } from "./db";
import { sql } from 'drizzle-orm';

async function rollbackMigration() {
  console.log('Starting rollback process...');
  
  try {
    // Check if backup tables exist
    const backupTablesExist = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'transactions_backup'
      ) as transactions_exist,
      EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'gift_cards_backup'
      ) as gift_cards_exist,
      EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'gift_card_redemptions_backup'
      ) as redemptions_exist;
    `);
    
    if (!backupTablesExist) {
      console.error('❌ Backup tables not found. Cannot rollback.');
      return false;
    }
    
    // Restore data from backup tables
    await db.execute(sql`
      -- Restore transactions
      TRUNCATE TABLE transactions;
      INSERT INTO transactions SELECT * FROM transactions_backup;
      
      -- Restore gift cards
      TRUNCATE TABLE gift_cards;
      INSERT INTO gift_cards SELECT * FROM gift_cards_backup;
      
      -- Restore redemptions
      TRUNCATE TABLE gift_card_redemptions;
      INSERT INTO gift_card_redemptions SELECT * FROM gift_card_redemptions_backup;
      
      -- Drop backup tables
      DROP TABLE transactions_backup;
      DROP TABLE gift_cards_backup;
      DROP TABLE gift_card_redemptions_backup;
    `);
    
    console.log('✅ Successfully rolled back to previous state');
    return true;
  } catch (error) {
    console.error('Error during rollback:', error);
    return false;
  }
}

// Only run if this file is executed directly
if (require.main === module) {
  rollbackMigration().catch(console.error);
}
