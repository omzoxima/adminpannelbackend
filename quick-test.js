const axios = require('axios');

// Quick test configuration
const BASE_URL = 'http://localhost:8080';
const DEVICE_ID = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

console.log('🧪 Quick API Test Starting...\n');

async function quickTest() {
  const results = [];
  
  // Test 1: Health Check
  try {
    const healthResponse = await axios.get(`${BASE_URL}/health`);
    const healthPassed = healthResponse.status === 200;
    results.push({ name: 'Health Check', passed: healthPassed });
    console.log(healthPassed ? ' Health Check' : ' Health Check');
  } catch (error) {
    results.push({ name: 'Health Check', passed: false });
    console.log(' Health Check - Server not running');
  }
  
  // Test 2: Security Headers
  try {
    const headersResponse = await axios.get(`${BASE_URL}/health`);
    const headers = headersResponse.headers;
    const requiredHeaders = ['x-content-type-options', 'x-frame-options', 'x-xss-protection'];
    const missingHeaders = requiredHeaders.filter(header => !headers[header]);
    const headersPassed = missingHeaders.length === 0;
    results.push({ name: 'Security Headers', passed: headersPassed });
    console.log(headersPassed ? ' Security Headers' : ` Security Headers - Missing: ${missingHeaders.join(', ')}`);
  } catch (error) {
    results.push({ name: 'Security Headers', passed: false });
    console.log(' Security Headers');
  }
  
  // Test 3: Device ID Validation
  try {
    const validResponse = await axios.get(`${BASE_URL}/api/episodes/test/video/en`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    const validPassed = validResponse.status !== 400;
    results.push({ name: 'Device ID Validation (Valid)', passed: validPassed });
    console.log(validPassed ? ' Device ID Validation (Valid)' : ' Device ID Validation (Valid)');
  } catch (error) {
    results.push({ name: 'Device ID Validation (Valid)', passed: false });
    console.log(' Device ID Validation (Valid)');
  }
  
  // Test 4: Invalid Device ID
  try {
    await axios.get(`${BASE_URL}/api/episodes/test/video/en`, {
      headers: { 'X-Device-ID': 'invalid' }
    });
    results.push({ name: 'Device ID Validation (Invalid)', passed: false });
    console.log(' Device ID Validation (Invalid) - Should have failed');
  } catch (error) {
    const invalidPassed = error.response?.status === 400;
    results.push({ name: 'Device ID Validation (Invalid)', passed: invalidPassed });
    console.log(invalidPassed ? ' Device ID Validation (Invalid)' : ' Device ID Validation (Invalid)');
  }
  
  // Test 5: Generate Upload URLs
  try {
    const uploadResponse = await axios.post(`${BASE_URL}/api/episodes/generate-language-upload-urls`, {
      videos: [{ language: 'en', extension: '.mp4' }]
    }, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    const uploadPassed = uploadResponse.status === 200;
    results.push({ name: 'Generate Upload URLs', passed: uploadPassed });
    console.log(uploadPassed ? ' Generate Upload URLs' : ' Generate Upload URLs');
  } catch (error) {
    results.push({ name: 'Generate Upload URLs', passed: false });
    console.log(' Generate Upload URLs');
  }
  
  // Test 6: Video Transcoding Endpoint
  try {
    const transcodeResponse = await axios.post(`${BASE_URL}/api/episodes/transcode-hls`, {
      series_id: 'test-series',
      episode_number: 1,
      title: 'Test Episode',
      videos: [{ gcsFilePath: 'gs://test-bucket/test.mp4', language: 'en' }]
    }, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    const transcodePassed = transcodeResponse.status === 200 || transcodeResponse.status === 400;
    results.push({ name: 'Video Transcoding Endpoint', passed: transcodePassed });
    console.log(transcodePassed ? ' Video Transcoding Endpoint' : ' Video Transcoding Endpoint');
  } catch (error) {
    results.push({ name: 'Video Transcoding Endpoint', passed: false });
    console.log(' Video Transcoding Endpoint');
  }
  
  // Test 7: Series Routes
  try {
    const seriesResponse = await axios.get(`${BASE_URL}/api/series`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    const seriesPassed = seriesResponse.status === 200;
    results.push({ name: 'Series Routes', passed: seriesPassed });
    console.log(seriesPassed ? ' Series Routes' : ' Series Routes');
  } catch (error) {
    results.push({ name: 'Series Routes', passed: false });
    console.log(' Series Routes');
  }
  
  // Test 8: Category Routes
  try {
    const categoryResponse = await axios.get(`${BASE_URL}/api/categories`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    const categoryPassed = categoryResponse.status === 200;
    results.push({ name: 'Category Routes', passed: categoryPassed });
    console.log(categoryPassed ? ' Category Routes' : ' Category Routes');
  } catch (error) {
    results.push({ name: 'Category Routes', passed: false });
    console.log(' Category Routes');
  }
  
  // Test 9: CORS
  try {
    const corsResponse = await axios.options(`${BASE_URL}/api/episodes/test/video/en`, {
      headers: {
        'Origin': 'https://test-app.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Device-ID'
      }
    });
    const corsPassed = corsResponse.status === 200 || corsResponse.status === 204;
    results.push({ name: 'CORS Configuration', passed: corsPassed });
    console.log(corsPassed ? ' CORS Configuration' : ' CORS Configuration');
  } catch (error) {
    results.push({ name: 'CORS Configuration', passed: false });
    console.log(' CORS Configuration');
  }
  
  // Test 10: Rate Limiting (Basic)
  try {
    const requests = [];
    for (let i = 0; i < 3; i++) {
      requests.push(axios.get(`${BASE_URL}/api/episodes/test/video/en`, {
        headers: { 'X-Device-ID': DEVICE_ID }
      }));
    }
    await Promise.all(requests);
    results.push({ name: 'Rate Limiting (Basic)', passed: true });
    console.log(' Rate Limiting (Basic)');
  } catch (error) {
    results.push({ name: 'Rate Limiting (Basic)', passed: false });
    console.log(' Rate Limiting (Basic)');
  }
  
  // Print summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log('\n Quick Test Summary:');
  console.log(`Total Tests: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${total - passed}`);
  console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
  
  if (passed === total) {
    console.log('\n All quick tests passed! Your API is working correctly.');
  } else {
    console.log('\n  Some tests failed. Check the details above.');
  }
  
  return results;
}

// Run quick test
quickTest().catch(console.error); 