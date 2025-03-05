/**
 * Test script to diagnose gift card update issues
 */

import { db } from './db';
import { sql } from 'drizzle-orm';
import { giftCards } from '../shared/schema';

async function testGiftCardUpdates() {
  try {
    // First, let's check the current value
    console.log("Checking initial value...");
    const initialData = await db.execute(sql`
      SELECT id, activation_amount FROM gift_cards WHERE id = 2223
    `);
    
    if (initialData.rows.length === 0) {
      console.error("Test gift card not found");
      return;
    }
    
    const originalValue = Number(initialData.rows[0].activation_amount);
    console.log(`Current activation_amount for ID 2223: $${originalValue}`);
    
    // Test 1: Update using Drizzle's update method
    console.log("\nTest 1: Using Drizzle's update method with 'activationAmount'");
    const testValue1 = 900.00;
    try {
      await db.update(giftCards)
        .set({ activationAmount: testValue1 })
        .where(sql`id = 2223`);
      
      console.log("Update appears successful via Drizzle ORM");
    } catch (error) {
      console.error("Error updating via Drizzle ORM:", error);
    }
    
    // Check if it worked
    const afterDrizzle = await db.execute(sql`
      SELECT activation_amount FROM gift_cards WHERE id = 2223
    `);
    
    const valueAfterDrizzle = Number(afterDrizzle.rows[0].activation_amount);
    console.log(`Value after Drizzle update: $${valueAfterDrizzle}`);
    const drizzleSuccess = valueAfterDrizzle === testValue1;
    console.log(`Drizzle update ${drizzleSuccess ? "SUCCESSFUL ✅" : "FAILED ❌"}`);
    
    // Test 2: Update using raw SQL
    console.log("\nTest 2: Using raw SQL with 'activation_amount'");
    const testValue2 = 999.99;
    try {
      await db.execute(sql`
        UPDATE gift_cards
        SET activation_amount = ${testValue2}
        WHERE id = 2223
      `);
      
      console.log("Update appears successful via raw SQL");
    } catch (error) {
      console.error("Error updating via raw SQL:", error);
    }
    
    // Check if it worked
    const afterRawSQL = await db.execute(sql`
      SELECT activation_amount FROM gift_cards WHERE id = 2223
    `);
    
    const valueAfterRawSQL = Number(afterRawSQL.rows[0].activation_amount);
    console.log(`Value after raw SQL update: $${valueAfterRawSQL}`);
    const rawSQLSuccess = valueAfterRawSQL === testValue2;
    console.log(`Raw SQL update ${rawSQLSuccess ? "SUCCESSFUL ✅" : "FAILED ❌"}`);
    
    // Test 3: Try a different Drizzle format
    console.log("\nTest 3: Using Drizzle's execute with SQL template");
    const testValue3 = 888.88;
    try {
      await db.execute(sql`
        UPDATE ${giftCards}
        SET ${giftCards.activationAmount} = ${testValue3}
        WHERE ${giftCards.id} = 2223
      `);
      
      console.log("Update appears successful via Drizzle SQL template");
    } catch (error) {
      console.error("Error updating via Drizzle SQL template:", error);
    }
    
    // Check if it worked
    const afterDrizzleSQL = await db.execute(sql`
      SELECT activation_amount FROM gift_cards WHERE id = 2223
    `);
    
    const valueAfterDrizzleSQL = Number(afterDrizzleSQL.rows[0].activation_amount);
    console.log(`Value after Drizzle SQL template update: $${valueAfterDrizzleSQL}`);
    const drizzleSQLSuccess = valueAfterDrizzleSQL === testValue3;
    console.log(`Drizzle SQL template update ${drizzleSQLSuccess ? "SUCCESSFUL ✅" : "FAILED ❌"}`);
    
    // Reset to original value
    console.log("\nResetting to original value");
    await db.execute(sql`
      UPDATE gift_cards
      SET activation_amount = ${originalValue}
      WHERE id = 2223
    `);
    
    const afterReset = await db.execute(sql`
      SELECT activation_amount FROM gift_cards WHERE id = 2223
    `);
    
    console.log(`Value after reset: $${Number(afterReset.rows[0].activation_amount)}`);
    console.log(`Original value restored: ${Number(afterReset.rows[0].activation_amount) === originalValue ? "Yes ✅" : "No ❌"}`);
    
    // Summary
    console.log("\n===== RESULTS SUMMARY =====");
    console.log(`Drizzle update with 'activationAmount': ${drizzleSuccess ? "WORKED ✅" : "FAILED ❌"}`);
    console.log(`Raw SQL update with 'activation_amount': ${rawSQLSuccess ? "WORKED ✅" : "FAILED ❌"}`);
    console.log(`Drizzle SQL template: ${drizzleSQLSuccess ? "WORKED ✅" : "FAILED ❌"}`);
    
    // Check current schema definition in Drizzle
    console.log("\n===== DRIZZLE SCHEMA =====");
    const columns = Object.keys(giftCards);
    console.log("Available columns in gift_cards schema:", columns);
    
  } catch (error) {
    console.error("Test failed with error:", error);
  }
}

// Run the test
testGiftCardUpdates().then(() => {
  console.log("Test completed");
}).catch(err => {
  console.error("Test failed:", err);
});