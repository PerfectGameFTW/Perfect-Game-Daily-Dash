// Test API endpoints
async function test() {
  try {
    console.log("Testing /api/summary...");
    const response = await fetch("http://localhost:5000/api/summary?dateRange=today");
    
    if (!response.ok) {
      console.error(`Error: API returned status ${response.status}`);
      const text = await response.text();
      console.error(`Response body: ${text}`);
      return;
    }
    
    const data = await response.json();
    console.log("API Response Data:", data);
    
    // Check if data is empty
    if (Object.keys(data).length === 0) {
      console.log("⚠️ API returned empty object");
    } else {
      console.log("✅ API returned data successfully");
      console.log("totalRevenue:", data.totalRevenue);
      console.log("revenueChange:", data.revenueChange);
      console.log("totalOrders:", data.totalOrders);
    }
  } catch (error) {
    console.error("Error testing API:", error.message);
  }
}

test();
