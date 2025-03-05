// Simple test script for gift card activations API
require('dotenv').config();
const { getGiftCardActivations } = require('./squareClient');

// Define date range for today
const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);

// Format dates for Square API
const beginTime = today.toISOString();
const endTime = tomorrow.toISOString();

// Test the function
async function testGiftCardActivations() {
  try {
    console.log(`Testing gift card activations from ${beginTime} to ${endTime}`);
    const amount = await getGiftCardActivations(today, tomorrow);
    console.log(`Gift card activations total: $${amount}`);
  } catch (error) {
    console.error('Error testing gift card activations:', error.message);
  }
}

testGiftCardActivations();