import { logger } from "../utils/logger.js";
import jwt from "jsonwebtoken";

/**
 * Production-grade Rate Limiting Middleware
 * Uses IP + User Agent as identifier for anonymous users
 * Uses User ID for authenticated users
 */

class RateLimiter {
  constructor() {
    this.stores = new Map(); // IP -> { count, resetTime }
    this.userStores = new Map(); // UserID -> { count, resetTime }
  }

  /**
   * Generate identifier based on IP and User Agent
   */
  getIdentifier(req) {
    return this.getClientIP(req);
  }

  /**
   * Get client IP from various sources
   */
  getClientIP(req) {
    return req.ip || req.socket?.remoteAddress || "unknown";
  }

  /**
   * Check if request is within rate limit
   */
  isWithinLimit(key, limit, windowMs) {
    const now = Date.now();
    const store = this.stores.get(key);

    if (!store) {
      // First request
      this.stores.set(key, { count: 1, resetTime: now + windowMs });
      return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
    }

    if (now > store.resetTime) {
      // Window expired, reset
      this.stores.set(key, { count: 1, resetTime: now + windowMs });
      return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
    }

    // Within window
    if (store.count >= limit) {
      return { allowed: false, remaining: 0, resetTime: store.resetTime };
    }

    store.count++;
    return { allowed: true, remaining: limit - store.count, resetTime: store.resetTime };
  }

  /**
   * Check user-based rate limit (for authenticated users)
   */
  isWithinUserLimit(userId, limit, windowMs) {
    const now = Date.now();
    const store = this.userStores.get(userId);

    if (!store) {
      this.userStores.set(userId, { count: 1, resetTime: now + windowMs });
      return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
    }

    if (now > store.resetTime) {
      this.userStores.set(userId, { count: 1, resetTime: now + windowMs });
      return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
    }

    if (store.count >= limit) {
      return { allowed: false, remaining: 0, resetTime: store.resetTime };
    }

    store.count++;
    return { allowed: true, remaining: limit - store.count, resetTime: store.resetTime };
  }

  /**
   * Clean up expired entries (call periodically)
   */
  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.stores.entries()) {
      if (now > value.resetTime) {
        this.stores.delete(key);
      }
    }
    for (const [key, value] of this.userStores.entries()) {
      if (now > value.resetTime) {
        this.userStores.delete(key);
      }
    }
  }
}

const limiter = new RateLimiter();

// Cleanup expired entries every 10 minutes
const cleanupInterval = setInterval(() => limiter.cleanup(), 10 * 60 * 1000);
cleanupInterval.unref?.();

function extractVerifiedUserId(req) {
  const tokenFromHeader = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.substring(7).trim()
    : null;
  const tokenFromCookie = req.cookies?.accessToken || null;
  const token = tokenFromHeader || tokenFromCookie;

  if (!token || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded?.userId !== undefined && decoded?.userId !== null) {
      return String(decoded.userId);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Rate Limit Configuration for different endpoint types
 */
const rateLimitConfigs = {
  // Auth endpoints - stricter limits
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 5, // 5 requests per window
  },
  // API endpoints - standard limits
  api: {
    windowMs: 60 * 1000, // 1 minute
    limit: 30, // 30 requests per minute
  },
  // Authenticated user endpoints - generous limits
  user: {
    windowMs: 60 * 1000, // 1 minute
    limit: 60, // 60 requests per minute
  },
  // Public endpoints - moderate limits
  public: {
    windowMs: 60 * 1000, // 1 minute
    limit: 20, // 20 requests per minute
  },
};

/**
 * Generic Rate Limit Middleware Factory
 */
export const createRateLimitMiddleware = (configKey = "api") => {
  const config = rateLimitConfigs[configKey] || rateLimitConfigs.api;

  return (req, res, next) => {
    const userId = extractVerifiedUserId(req);

    let rateLimitResult;
    let identifier;

    if (userId) {
      // Use user-based rate limiting for authenticated requests
      rateLimitResult = limiter.isWithinUserLimit(userId, config.limit, config.windowMs);
      identifier = `user:${userId}`;
    } else {
      // Use IP + User Agent for anonymous requests
      identifier = limiter.getIdentifier(req);
      rateLimitResult = limiter.isWithinLimit(identifier, config.limit, config.windowMs);
    }

    // Set rate limit headers
    res.set("RateLimit-Limit", config.limit);
    res.set("RateLimit-Remaining", Math.max(0, rateLimitResult.remaining));
    res.set("RateLimit-Reset", new Date(rateLimitResult.resetTime).toISOString());

    if (!rateLimitResult.allowed) {
      logger.warn("Rate limit exceeded", {
        identifier,
        endpoint: req.path,
        method: req.method,
        resetTime: new Date(rateLimitResult.resetTime),
      });

      return res.status(429).json({
        message: "Too many requests, please try again later",
        retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000),
      });
    }

    next();
  };
};

/**
 * Pre-built middleware instances for common use cases
 */
export const authRateLimit = createRateLimitMiddleware("auth");
export const apiRateLimit = createRateLimitMiddleware("api");
export const userRateLimit = createRateLimitMiddleware("user");
export const publicRateLimit = createRateLimitMiddleware("public");

export default createRateLimitMiddleware;
