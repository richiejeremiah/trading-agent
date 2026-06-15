/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and DDoS attacks
 */

const rateLimit = require('express-rate-limit');

const INTERNAL_JOB_TOKEN = process.env.INTERNAL_JOB_TOKEN || null;
const shouldSkipInternalJob = (req) =>
  INTERNAL_JOB_TOKEN && req.headers['x-internal-job-token'] === INTERNAL_JOB_TOKEN;

/** GET catalog list — separate bucket so checkout + landing + retries do not exhaust the global API limiter. */
function isPublicCatalogRead(req) {
  if (req.method !== 'GET') return false;
  const p = req.path || '';
  return (
    p === '/api/public/products' ||
    p.startsWith('/api/public/products/') ||
    p === '/public/products' ||
    p.startsWith('/public/products/') ||
    p === '/api/public/prescriptions' ||
    p.startsWith('/api/public/prescriptions/') ||
    p === '/public/prescriptions' ||
    p.startsWith('/public/prescriptions/')
  );
}

/** Public commerce (quote, cart, checkout helpers) — own bucket so quote/cart bursts do not starve catalog reads. */
function isPublicCommercePath(req) {
  const p = req.path || '';
  return p.startsWith('/api/public/commerce') || p.startsWith('/public/commerce');
}

// Custom key generator that handles IP addresses with ports and trust proxy
const keyGenerator = (req) => {
  // Extract IP from req.ip, removing port if present
  let ip = req.ip || req.connection?.remoteAddress || 'unknown';

  // Remove port number if present (e.g., "54.196.252.50:54288" -> "54.196.252.50")
  if (ip && ip.includes(':')) {
    // Handle IPv6 addresses (e.g., "::ffff:169.254.130.1")
    if (ip.startsWith('::ffff:')) {
      ip = ip.replace('::ffff:', '');
    }
    // Remove port number
    const parts = ip.split(':');
    ip = parts[0];
  }

  return ip || 'unknown';
};

// General API rate limiter
// Note: trust proxy must be set in server.js before this middleware is used
// In development, use a much higher limit to avoid 429s from dashboard polling + PDF processing
const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 2000 : 100, // Dev: 2000/15min to avoid 429s; Prod: 100
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator, // Custom key generator to handle IP addresses with ports
  validate: {
    trustProxy: false, // Disable trust proxy validation
    ip: false // Disable IP validation to handle IPs with ports
  },
  skip: (req) =>
    shouldSkipInternalJob(req) || isPublicCatalogRead(req) || isPublicCommercePath(req)
});

const publicCatalogReadMax = parseInt(
  process.env.PUBLIC_CATALOG_RATE_MAX || (isDev ? '8000' : '1200'),
  10
);
const publicCatalogReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.isFinite(publicCatalogReadMax) && publicCatalogReadMax > 0 ? publicCatalogReadMax : 1200,
  message: {
    error: 'Too many catalog requests from this IP, please try again shortly.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: { trustProxy: false, ip: false },
  skip: shouldSkipInternalJob
});

const publicDiagnosticsMax = parseInt(process.env.PUBLIC_DIAGNOSTICS_RATE_MAX || (isDev ? '2000' : '300'), 10);
const publicDiagnosticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.isFinite(publicDiagnosticsMax) && publicDiagnosticsMax > 0 ? publicDiagnosticsMax : 300,
  message: {
    error: 'Too many diagnostic requests from this IP, please try again shortly.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: { trustProxy: false, ip: false },
  skip: shouldSkipInternalJob
});

const publicCommerceMax = parseInt(
  process.env.PUBLIC_COMMERCE_RATE_MAX || (isDev ? '4000' : '400'),
  10
);
const publicCommerceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.isFinite(publicCommerceMax) && publicCommerceMax > 0 ? publicCommerceMax : 400,
  message: {
    error: 'Too many checkout requests from this IP, please try again shortly.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: { trustProxy: false, ip: false },
  skip: shouldSkipInternalJob
});

// Strict rate limiter for sensitive endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator, // Custom key generator to handle IP addresses with ports
  validate: {
    trustProxy: false, // Disable trust proxy validation
    ip: false // Disable IP validation to handle IPs with ports
  },
  skip: shouldSkipInternalJob
});

// Authentication endpoints (login, signup, verification) - stricter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 auth attempts per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.',
    retryAfter: '15 minutes'
  },
  skipSuccessfulRequests: true, // Don't count successful requests
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator, // Custom key generator to handle IP addresses with ports
  validate: {
    trustProxy: false, // Disable trust proxy validation
    ip: false // Disable IP validation to handle IPs with ports
  },
  skip: shouldSkipInternalJob
});

// More lenient limiter for tenant logins (email + password) so real users don't hit 429 easily
const lenientAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Allow more attempts per IP for login-only endpoint
  message: {
    error: 'Too many login attempts, please wait and try again.',
    retryAfter: '15 minutes'
  },
  skipSuccessfulRequests: true, // Successful logins don't count
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    trustProxy: false,
    ip: false
  },
  skip: shouldSkipInternalJob
});

// Internal admin dashboard fetches (allow generous burst, still guard abuse)
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: parseInt(process.env.ADMIN_API_MAX_REQUESTS || '300', 10), // generous default
  message: {
    error: 'Admin data refresh limit reached. Please pause for a moment.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    trustProxy: false,
    ip: false
  },
  skip: shouldSkipInternalJob
});

// Payment endpoints - very strict
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Limit each IP to 10 payment requests per hour
  message: {
    error: 'Too many payment requests, please try again later.',
    retryAfter: '1 hour'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator, // Custom key generator to handle IP addresses with ports
  validate: {
    trustProxy: false, // Disable trust proxy validation
    ip: false // Disable IP validation to handle IPs with ports
  },
  skip: shouldSkipInternalJob
});

// Voice endpoints - moderate
const voiceLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Limit each IP to 20 voice requests per minute
  message: {
    error: 'Too many voice requests, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator, // Custom key generator to handle IP addresses with ports
  validate: {
    trustProxy: false, // Disable trust proxy validation
    ip: false // Disable IP validation to handle IPs with ports
  },
  skip: shouldSkipInternalJob
});

// Task 27: Strict rate limiting for schedule and checkout (voice agent abuse prevention)
const scheduleCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 requests per 15 min per IP
  message: {
    error: 'Too many scheduling or checkout requests. Please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: { trustProxy: false, ip: false },
  skip: shouldSkipInternalJob
});

// Chat commands - moderate (allows quick actions but prevents abuse)
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // Limit each IP to 20 commands per minute
  message: {
    error: 'Too many chat commands, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  validate: {
    trustProxy: false,
    ip: false
  },
  skip: shouldSkipInternalJob
});

module.exports = {
  apiLimiter,
  publicCatalogReadLimiter,
  publicDiagnosticsLimiter,
  publicCommerceLimiter,
  isPublicCatalogRead,
  isPublicCommercePath,
  strictLimiter,
  authLimiter,
  lenientAuthLimiter,
  adminLimiter,
  paymentLimiter,
  voiceLimiter,
  chatLimiter,
  scheduleCheckoutLimiter
};

