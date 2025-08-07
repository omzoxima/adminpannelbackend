const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Security configuration
const SECURITY_CONFIG = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
  DEVICE_ID_SALT: process.env.DEVICE_ID_SALT || crypto.randomBytes(16).toString('hex'),
  SIGNED_URL_EXPIRY: 60, // 1 minute
  MAX_DEVICE_CHANGES: 3,
  RATE_LIMIT_WINDOW: 15 * 60 * 1000, // 15 minutes
  MAX_REQUESTS_PER_WINDOW: 1000 // Increased for testing
};

// Rate limiting store
const rateLimitStore = new Map();

/**
 * Encrypt sensitive data
 */
function encryptData(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipher('aes-256-gcm', SECURITY_CONFIG.ENCRYPTION_KEY);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Decrypt sensitive data
 */
function decryptData(encryptedData) {
  try {
    const decipher = crypto.createDecipher('aes-256-gcm', SECURITY_CONFIG.ENCRYPTION_KEY);
    decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
    let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error('Invalid encrypted data');
  }
}

/**
 * Hash device ID for security
 */
function hashDeviceId(deviceId) {
  return crypto.createHmac('sha256', SECURITY_CONFIG.DEVICE_ID_SALT)
    .update(deviceId)
    .digest('hex');
}

/**
 * Validate device ID format
 */
function validateDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    return false;
  }
  
  // Device ID should be 8-64 characters alphanumeric with dots allowed
  // This supports formats like: BP22.250325.006, abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
  const deviceIdRegex = /^[a-zA-Z0-9.]{8,64}$/;
  return deviceIdRegex.test(deviceId);
}

/**
 * Generate secure signed URL with device validation
 */
function generateSecureSignedUrl(filePath, deviceId, userId, expirySeconds = SECURITY_CONFIG.SIGNED_URL_EXPIRY) {
  if (!validateDeviceId(deviceId)) {
    throw new Error('Invalid device ID');
  }

  // Create payload with device validation
  const payload = {
    filePath,
    deviceId: hashDeviceId(deviceId),
    userId,
    timestamp: Date.now(),
    expiry: Date.now() + (expirySeconds * 1000)
  };

  // Encrypt the payload
  const encryptedPayload = encryptData(payload);
  
  // Create JWT token
  const token = jwt.sign(encryptedPayload, process.env.JWT_SECRET, {
    expiresIn: expirySeconds
  });

  return token;
}

/**
 * Verify secure signed URL
 */
function verifySecureSignedUrl(token, deviceId) {
  try {
    if (!validateDeviceId(deviceId)) {
      throw new Error('Invalid device ID');
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Decrypt payload
    const payload = decryptData(decoded);
    
    // Check if token is expired
    if (Date.now() > payload.expiry) {
      throw new Error('Token expired');
    }

    // Verify device ID
    if (payload.deviceId !== hashDeviceId(deviceId)) {
      throw new Error('Device ID mismatch');
    }

    return payload.filePath;
  } catch (error) {
    throw new Error('Invalid signed URL');
  }
}

/**
 * Rate limiting middleware
 */
function rateLimitMiddleware(req, res, next) {
  const clientId = req.headers['x-device-id'] || req.ip;
  const now = Date.now();
  
  // Skip rate limiting for health checks
  if (req.path === '/health') {
    return next();
  }
  
  if (!rateLimitStore.has(clientId)) {
    rateLimitStore.set(clientId, {
      requests: [],
      blocked: false,
      blockUntil: 0
    });
  }

  const client = rateLimitStore.get(clientId);
  
  // Check if client is blocked
  if (client.blocked && now < client.blockUntil) {
    return res.status(429).json({
      error: 'Too many requests',
      retryAfter: Math.ceil((client.blockUntil - now) / 1000)
    });
  }

  // Clean old requests
  client.requests = client.requests.filter(time => now - time < SECURITY_CONFIG.RATE_LIMIT_WINDOW);

  // Check rate limit
  if (client.requests.length >= SECURITY_CONFIG.MAX_REQUESTS_PER_WINDOW) {
    client.blocked = true;
    client.blockUntil = now + (SECURITY_CONFIG.RATE_LIMIT_WINDOW * 2);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: SECURITY_CONFIG.RATE_LIMIT_WINDOW / 1000
    });
  }

  // Add current request
  client.requests.push(now);
  next();
}

/**
 * Device validation middleware
 */
function deviceValidationMiddleware(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const userAgent = req.headers['user-agent'];

  if (!deviceId) {
    return res.status(400).json({ error: 'Device ID required' });
  }

  if (!validateDeviceId(deviceId)) {
    return res.status(400).json({ error: 'Invalid device ID format' });
  }

  // Add device info to request
  req.deviceInfo = {
    id: hashDeviceId(deviceId),
    userAgent,
    ip: req.ip
  };

  next();
}

/**
 * Security headers middleware
 */
function securityHeadersMiddleware(req, res, next) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  next();
}

/**
 * Validate video format for iOS/Android compatibility
 */
function validateVideoFormat(videoInfo) {
  const supportedFormats = {
    ios: ['h264', 'aac', 'mp4'],
    android: ['h264', 'aac', 'mp4', 'h265', 'vp9']
  };

  const format = videoInfo.format?.toLowerCase();
  const codec = videoInfo.codec?.toLowerCase();

  return {
    ios: supportedFormats.ios.includes(codec) && supportedFormats.ios.includes(format),
    android: supportedFormats.android.includes(codec) && supportedFormats.android.includes(format)
  };
}

/**
 * Generate device-specific video URL
 */
function generateDeviceSpecificVideoUrl(filePath, deviceId, userId, platform) {
  const baseUrl = generateSecureSignedUrl(filePath, deviceId, userId);
  
  // Add platform-specific parameters
  const platformParams = {
    ios: '&platform=ios&codec=h264',
    android: '&platform=android&codec=h264'
  };

  return `${baseUrl}${platformParams[platform] || ''}`;
}

module.exports = {
  encryptData,
  decryptData,
  hashDeviceId,
  validateDeviceId,
  generateSecureSignedUrl,
  verifySecureSignedUrl,
  rateLimitMiddleware,
  deviceValidationMiddleware,
  securityHeadersMiddleware,
  validateVideoFormat,
  generateDeviceSpecificVideoUrl,
  SECURITY_CONFIG
}; 