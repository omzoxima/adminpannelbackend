const axios = require('axios');
const crypto = require('crypto');

// Test configuration
const TEST_CONFIG = {
  BASE_URL: process.env.TEST_BASE_URL || 'http://localhost:8080',
  JWT_TOKEN: process.env.TEST_JWT_TOKEN || 'your-jwt-token-here',
  DEVICE_ID: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
  TEST_SERIES_ID: 'test-series-id',
  TEST_EPISODE_ID: 'test-episode-id'
};

// Test results
const testResults = {
  passed: 0,
  failed: 0,
  total: 0,
  details: []
};

/**
 * Generate test device ID
 */
function generateTestDeviceId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Log test result
 */
function logTest(testName, passed, details = '') {
  testResults.total++;
  if (passed) {
    testResults.passed++;
    console.log(` ${testName}`);
  } else {
    testResults.failed++;
    console.log(` ${testName} - ${details}`);
  }
  testResults.details.push({ name: testName, passed, details });
}

/**
 * Make API request with proper headers
 */
async function makeRequest(method, endpoint, data = null, additionalHeaders = {}) {
  try {
    const headers = {
      'Authorization': `Bearer ${TEST_CONFIG.JWT_TOKEN}`,
      'X-Device-ID': TEST_CONFIG.DEVICE_ID,
      'X-Platform': 'android',
      'Content-Type': 'application/json',
      ...additionalHeaders
    };

    const config = {
      method,
      url: `${TEST_CONFIG.BASE_URL}${endpoint}`,
      headers,
      data,
      timeout: 30000
    };

    const response = await axios(config);
    return { success: true, data: response.data, status: response.status };
  } catch (error) {
    return { 
      success: false, 
      error: error.response?.data || error.message, 
      status: error.response?.status 
    };
  }
}

/**
 * Test 1: Health Check
 */
async function testHealthCheck() {
  try {
    const response = await axios.get(`${TEST_CONFIG.BASE_URL}/health`);
    const passed = response.status === 200 && response.data === 'OK';
    logTest('Health Check', passed);
  } catch (error) {
    logTest('Health Check', false, error.message);
  }
}

/**
 * Test 2: Security Headers
 */
async function testSecurityHeaders() {
  try {
    const response = await axios.get(`${TEST_CONFIG.BASE_URL}/health`);
    const headers = response.headers;
    
    const requiredHeaders = [
      'x-content-type-options',
      'x-frame-options',
      'x-xss-protection',
      'strict-transport-security'
    ];
    
    const missingHeaders = requiredHeaders.filter(header => !headers[header]);
    const passed = missingHeaders.length === 0;
    
    logTest('Security Headers', passed, missingHeaders.length > 0 ? `Missing: ${missingHeaders.join(', ')}` : '');
  } catch (error) {
    logTest('Security Headers', false, error.message);
  }
}

/**
 * Test 3: Device ID Validation
 */
async function testDeviceIdValidation() {
  // Test with valid device ID
  const validResponse = await makeRequest('GET', '/api/episodes/test-episode/video/en');
  const validPassed = validResponse.status !== 400 || !validResponse.error?.includes('Invalid device ID');
  
  // Test with invalid device ID
  const invalidResponse = await makeRequest('GET', '/api/episodes/test-episode/video/en', null, {
    'X-Device-ID': 'invalid-device-id'
  });
  const invalidPassed = invalidResponse.status === 400 && invalidResponse.error?.includes('Invalid device ID');
  
  const passed = validPassed && invalidPassed;
  logTest('Device ID Validation', passed, validPassed && invalidPassed ? '' : 'Device ID validation not working properly');
}

/**
 * Test 4: Rate Limiting
 */
async function testRateLimiting() {
  const requests = [];
  
  // Make multiple requests quickly
  for (let i = 0; i < 5; i++) {
    requests.push(makeRequest('GET', '/api/episodes/test-episode/video/en'));
  }
  
  const responses = await Promise.all(requests);
  const rateLimited = responses.some(res => res.status === 429);
  
  logTest('Rate Limiting', rateLimited, rateLimited ? '' : 'Rate limiting not working');
}

/**
 * Test 5: Admin Login
 */
async function testAdminLogin() {
  const response = await makeRequest('POST', '/api/admin/login', {
    phone_or_email: 'test@example.com',
    password: 'testpassword'
  });
  
  const passed = response.status === 401; // Should fail with invalid credentials
  logTest('Admin Login (Invalid Credentials)', passed, passed ? '' : 'Login validation not working');
}

/**
 * Test 6: Generate Upload URLs
 */
async function testGenerateUploadUrls() {
  const response = await makeRequest('POST', '/api/episodes/generate-language-upload-urls', {
    videos: [
      { language: 'en', extension: '.mp4' },
      { language: 'hi', extension: '.mp4' }
    ]
  });
  
  const passed = response.success && response.data.uploads && response.data.uploads.length === 2;
  logTest('Generate Upload URLs', passed, passed ? '' : 'Upload URL generation failed');
}

/**
 * Test 7: Video Transcoding (Mock)
 */
async function testVideoTranscoding() {
  const response = await makeRequest('POST', '/api/episodes/transcode-hls', {
    series_id: TEST_CONFIG.TEST_SERIES_ID,
    episode_number: 1,
    title: 'Test Episode',
    videos: [
      {
        gcsFilePath: 'gs://test-bucket/test-video.mp4',
        language: 'en'
      }
    ]
  });
  
  // Should either succeed or fail gracefully
  const passed = response.success || (response.status === 400 && response.error);
  logTest('Video Transcoding', passed, passed ? '' : 'Transcoding endpoint not responding');
}

/**
 * Test 8: Get Secure Video URL
 */
async function testGetSecureVideoUrl() {
  const response = await makeRequest('GET', `/api/episodes/${TEST_CONFIG.TEST_EPISODE_ID}/video/en`);
  
  const passed = response.success && response.data.videoUrl;
  logTest('Get Secure Video URL', passed, passed ? '' : 'Secure video URL generation failed');
}

/**
 * Test 9: CORS Configuration
 */
async function testCORS() {
  try {
    const response = await axios.options(`${TEST_CONFIG.BASE_URL}/api/episodes/test-episode/video/en`, {
      headers: {
        'Origin': 'https://test-app.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Device-ID,Authorization'
      }
    });
    
    const passed = response.status === 200 || response.status === 204;
    logTest('CORS Configuration', passed, passed ? '' : 'CORS not configured properly');
  } catch (error) {
    logTest('CORS Configuration', false, error.message);
  }
}

/**
 * Test 10: Episode CRUD Operations
 */
async function testEpisodeCRUD() {
  // Test delete episode
  const deleteResponse = await makeRequest('POST', '/api/episodes/delete', {
    id: 'non-existent-id'
  });
  
  const deletePassed = deleteResponse.status === 404; // Should fail for non-existent episode
  
  // Test update episode
  const updateResponse = await makeRequest('POST', '/api/episodes/update', {
    id: 'non-existent-id',
    title: 'Updated Title'
  });
  
  const updatePassed = updateResponse.status === 404; // Should fail for non-existent episode
  
  const passed = deletePassed && updatePassed;
  logTest('Episode CRUD Operations', passed, passed ? '' : 'CRUD operations not working properly');
}

/**
 * Test 11: Series Routes
 */
async function testSeriesRoutes() {
  // Test get all series
  const getAllResponse = await makeRequest('GET', '/api/series');
  const getAllPassed = getAllResponse.success;
  
  // Test get series by ID
  const getByIdResponse = await makeRequest('GET', `/api/series/${TEST_CONFIG.TEST_SERIES_ID}`);
  const getByIdPassed = getByIdResponse.status === 404; // Should fail for non-existent series
  
  const passed = getAllPassed && getByIdPassed;
  logTest('Series Routes', passed, passed ? '' : 'Series routes not working properly');
}

/**
 * Test 12: Category Routes
 */
async function testCategoryRoutes() {
  const response = await makeRequest('GET', '/api/categories');
  const passed = response.success;
  logTest('Category Routes', passed, passed ? '' : 'Category routes not working properly');
}

/**
 * Test 13: User Routes
 */
async function testUserRoutes() {
  const response = await makeRequest('DELETE', `/api/users/${TEST_CONFIG.TEST_EPISODE_ID}`);
  const passed = response.status === 404; // Should fail for non-existent user
  logTest('User Routes', passed, passed ? '' : 'User routes not working properly');
}

/**
 * Test 14: JWT Authentication
 */
async function testJWTAuthentication() {
  // Test without token
  const noTokenResponse = await makeRequest('GET', '/api/episodes/test-episode/video/en', null, {
    'Authorization': undefined
  });
  
  const noTokenPassed = noTokenResponse.status === 401;
  
  // Test with invalid token
  const invalidTokenResponse = await makeRequest('GET', '/api/episodes/test-episode/video/en', null, {
    'Authorization': 'Bearer invalid-token'
  });
  
  const invalidTokenPassed = invalidTokenResponse.status === 403;
  
  const passed = noTokenPassed && invalidTokenPassed;
  logTest('JWT Authentication', passed, passed ? '' : 'JWT authentication not working properly');
}

/**
 * Test 15: Video Format Compatibility
 */
async function testVideoFormatCompatibility() {
  // This would test the video format validation logic
  // For now, we'll test the endpoint exists
  const response = await makeRequest('POST', '/api/episodes/transcode-hls', {
    series_id: TEST_CONFIG.TEST_SERIES_ID,
    episode_number: 1,
    title: 'Compatibility Test',
    videos: [
      {
        gcsFilePath: 'gs://test-bucket/compatibility-test.mp4',
        language: 'en'
      }
    ]
  });
  
  const passed = response.success || response.status === 400;
  logTest('Video Format Compatibility', passed, passed ? '' : 'Video format compatibility test failed');
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('🧪 Starting Comprehensive API Tests...\n');
  
  const tests = [
    testHealthCheck,
    testSecurityHeaders,
    testDeviceIdValidation,
    testRateLimiting,
    testAdminLogin,
    testGenerateUploadUrls,
    testVideoTranscoding,
    testGetSecureVideoUrl,
    testCORS,
    testEpisodeCRUD,
    testSeriesRoutes,
    testCategoryRoutes,
    testUserRoutes,
    testJWTAuthentication,
    testVideoFormatCompatibility
  ];
  
  for (const test of tests) {
    try {
      await test();
    } catch (error) {
      console.log(` Test failed with error: ${error.message}`);
    }
  }
  
  // Print summary
  console.log('\n Test Summary:');
  console.log(`Total Tests: ${testResults.total}`);
  console.log(`Passed: ${testResults.passed}`);
  console.log(`Failed: ${testResults.failed}`);
  console.log(`Success Rate: ${((testResults.passed / testResults.total) * 100).toFixed(1)}%`);
  
  if (testResults.failed === 0) {
    console.log('\n All tests passed! Your API is working correctly.');
  } else {
    console.log('\n Some tests failed. Check the details above.');
  }
  
  // Print detailed results
  console.log('\n Detailed Results:');
  testResults.details.forEach(result => {
    const status = result.passed ? '✅' : '❌';
    console.log(`${status} ${result.name}`);
    if (!result.passed && result.details) {
      console.log(`   Details: ${result.details}`);
    }
  });
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = {
  runAllTests,
  testResults
}; 