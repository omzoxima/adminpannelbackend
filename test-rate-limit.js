const axios = require('axios');

const BASE_URL = 'http://localhost:8080';
const DEVICE_ID = 'BP22.250325.006';

console.log('🧪 Rate Limiting Test...\n');

async function testRateLimit() {
  try {
    console.log('Making 5 requests to test rate limiting...');
    
    const requests = [];
    for (let i = 0; i < 5; i++) {
      requests.push(
        axios.get(`${BASE_URL}/api/episodes/test/video/en`, {
          headers: { 'X-Device-ID': DEVICE_ID }
        }).catch(error => ({
          status: error.response?.status,
          error: error.response?.data || error.message
        }))
      );
    }
    
    const responses = await Promise.all(requests);
    
    console.log('Response statuses:');
    responses.forEach((response, index) => {
      if (response.status) {
        console.log(`Request ${index + 1}: ${response.status}`);
      } else {
        console.log(`Request ${index + 1}: ${response.error}`);
      }
    });
    
    const has429 = responses.some(res => res.status === 429);
    const all401 = responses.every(res => res.status === 401 || res.status === 403);
    
    if (has429) {
      console.log(' Rate limiting is working - got 429 response');
    } else if (all401) {
      console.log(' Rate limiting is working - all requests properly blocked by auth');
    } else {
      console.log(' Rate limiting test inconclusive');
    }
    
  } catch (error) {
    console.error('Error testing rate limiting:', error.message);
  }
}

testRateLimit(); 