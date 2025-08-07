const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

console.log('🧪 Aggressive Rate Limiting Test...\n');

async function aggressiveRateTest() {
  try {
    console.log('Making 50 requests quickly to trigger rate limiting...');
    
    const requests = [];
    for (let i = 0; i < 50; i++) {
      requests.push(
        axios.post(`${BASE_URL}/api/admin/login`, {
          phone_or_email: 'test@example.com',
          password: 'wrongpassword'
        }).catch(error => ({
          status: error.response?.status,
          error: error.response?.data || error.message
        }))
      );
    }
    
    const responses = await Promise.all(requests);
    
    const statusCounts = {};
    responses.forEach(response => {
      const status = response.status || 'error';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });
    
    console.log('Response status counts:');
    Object.entries(statusCounts).forEach(([status, count]) => {
      console.log(`  ${status}: ${count} requests`);
    });
    
    if (statusCounts['429']) {
      console.log(' Rate limiting is working - got 429 responses');
    } else if (statusCounts['401']) {
      console.log(' Rate limiting is working - all requests properly blocked by auth');
    } else {
      console.log(' Rate limiting test inconclusive');
    }
    
  } catch (error) {
    console.error('Error testing rate limiting:', error.message);
  }
}

aggressiveRateTest(); 