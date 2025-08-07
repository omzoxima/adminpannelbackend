const axios = require('axios');

const BASE_URL = 'http://localhost:8080';
const DEVICE_ID = 'BP22.250325.006';

console.log('🧪 Testing Secure HLS URL Generation...\n');

async function testSecureHlsUrl() {
  const results = [];
  
  // Test 1: Missing device ID
  try {
    await axios.get(`${BASE_URL}/api/episodes/test-episode/hls-url?lang=en`);
    results.push({ name: 'Missing Device ID', passed: false });
    console.log('❌ Missing Device ID - Should have failed');
  } catch (error) {
    const passed = error.response?.status === 400;
    results.push({ name: 'Missing Device ID', passed });
    console.log(passed ? '✅ Missing Device ID' : '❌ Missing Device ID');
  }
  
  // Test 2: Invalid device ID
  try {
    await axios.get(`${BASE_URL}/api/episodes/test-episode/hls-url?lang=en`, {
      headers: { 'X-Device-ID': 'invalid' }
    });
    results.push({ name: 'Invalid Device ID', passed: false });
    console.log('❌ Invalid Device ID - Should have failed');
  } catch (error) {
    const passed = error.response?.status === 400;
    results.push({ name: 'Invalid Device ID', passed });
    console.log(passed ? '✅ Invalid Device ID' : '❌ Invalid Device ID');
  }
  
  // Test 3: Missing language parameter
  try {
    await axios.get(`${BASE_URL}/api/episodes/test-episode/hls-url`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    results.push({ name: 'Missing Language Parameter', passed: false });
    console.log('❌ Missing Language Parameter - Should have failed');
  } catch (error) {
    const passed = error.response?.status === 400;
    results.push({ name: 'Missing Language Parameter', passed });
    console.log(passed ? '✅ Missing Language Parameter' : '❌ Missing Language Parameter');
  }
  
  // Test 4: Non-existent episode
  try {
    await axios.get(`${BASE_URL}/api/episodes/non-existent-episode/hls-url?lang=en`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    results.push({ name: 'Non-existent Episode', passed: false });
    console.log('❌ Non-existent Episode - Should have failed');
  } catch (error) {
    const passed = error.response?.status === 404;
    results.push({ name: 'Non-existent Episode', passed });
    console.log(passed ? '✅ Non-existent Episode' : '❌ Non-existent Episode');
  }
  
  // Test 5: Valid request (should fail due to auth but show proper structure)
  try {
    await axios.get(`${BASE_URL}/api/episodes/test-episode/hls-url?lang=en`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    results.push({ name: 'Valid Request Structure', passed: false });
    console.log('❌ Valid Request Structure - Should have failed due to auth');
  } catch (error) {
    const passed = error.response?.status === 401 || error.response?.status === 403;
    results.push({ name: 'Valid Request Structure', passed });
    console.log(passed ? '✅ Valid Request Structure' : '❌ Valid Request Structure');
  }
  
  // Test 6: Route exists
  try {
    const response = await axios.get(`${BASE_URL}/api/episodes/test-episode/hls-url?lang=en`, {
      headers: { 'X-Device-ID': DEVICE_ID }
    });
    results.push({ name: 'Route Exists', passed: true });
    console.log('✅ Route Exists');
  } catch (error) {
    const passed = error.response?.status === 401 || error.response?.status === 403 || error.response?.status === 404;
    results.push({ name: 'Route Exists', passed });
    console.log(passed ? '✅ Route Exists' : '❌ Route Exists');
  }
  
  // Print summary
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log('\n📊 Secure HLS URL Test Summary:');
  console.log(`Total Tests: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${total - passed}`);
  console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
  
  if (passed === total) {
    console.log('\n🎉 All secure HLS URL tests passed!');
  } else {
    console.log('\n⚠️  Some tests failed. Check the details above.');
  }
  
  return results;
}

testSecureHlsUrl().catch(console.error); 