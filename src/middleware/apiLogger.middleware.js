import { logger } from "../utils/logger.js";

/**
 * API Request Logging Middleware
 * Logs all incoming API requests with endpoint, method, query params, and body
 */
export const apiLogger = (req, res, next) => {
  const startTime = Date.now();

  // Log incoming request
  const requestData = {
    method: req.method,
    endpoint: req.path,
    queryParams: Object.keys(req.query).length > 0 ? req.query : null,
    body: req.body && Object.keys(req.body).length > 0 ? req.body : null,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  };

  logger.api(
    req.method,
    req.path,
    "INCOMING",
    requestData.body || requestData.queryParams || null
  );

  // Intercept response
  const originalSend = res.send;
  res.send = function (data) {
    const duration = Date.now() - startTime;
    
    // Log response
    logger.api(req.method, req.path, res.statusCode, {
      duration: `${duration}ms`,
    });

    // Call original send
    return originalSend.call(this, data);
  };

  next();
};

export default apiLogger;
