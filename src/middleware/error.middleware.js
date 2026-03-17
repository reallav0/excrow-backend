import { logger } from "../utils/logger.js";

/**
 * Global error handler middleware.
 * Must be registered LAST in the Express middleware chain.
 *
 * Catches unhandled errors and returns a safe JSON response.
 * In production, stack traces and internal messages are hidden.
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  // Log full error server-side
  logger.error(`Unhandled error: ${req.method} ${req.path}`, err);

  // Never leak internal details in production
  const isProd = process.env.NODE_ENV === "production";

  res.status(status).json({
    message: isProd ? "Internal server error" : err.message,
    ...(!isProd && { stack: err.stack }),
  });
}

/**
 * 404 handler for unknown routes.
 * Register after all legitimate route handlers.
 */
export function notFoundHandler(req, res) {
  res.status(404).json({ message: "Route not found" });
}
