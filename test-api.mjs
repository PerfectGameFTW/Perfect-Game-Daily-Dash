// Test API endpoints
import fetch from "node-fetch";
async function test() {
  try {
    console.log("Testing /api/summary?dateRange=today");
    const summaryResponse = await fetch("http://localhost:3000/api/summary?dateRange=today");
    const summaryData = await summaryResponse.json();
    console.log("Summary data:", JSON.stringify(summaryData, null, 2));
    console.log("Status:", summaryResponse.status);
    console.log("\nTesting /api/hourly-revenue?dateRange=today");
    const hourlyResponse = await fetch("http://localhost:3000/api/hourly-revenue?dateRange=today");
    const hourlyData = await hourlyResponse.json();
    console.log("Hourly data:", JSON.stringify(hourlyData.slice(0, 3), null, 2));
    console.log("Status:", hourlyResponse.status);
  } catch (error) {
    console.error("Error testing API:", error);
  }
}
test();
