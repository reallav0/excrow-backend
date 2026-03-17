import { logger } from "../utils/logger.js";

/**
 * Sensitive fields that should never appear in logs.
 */
const SENSITIVE_FIELDS = new Set([
  "password", "passwordHash", "token", "refreshToken",
  "captchaToken", "secret", "mnemonic", "privateKey",
  "accessToken", "currentPassword", "newPassword",
]);

/**
 * Shallow-redact sensitive fields from a body object before logging.
 */
function sanitizeBody(body) {
  if (!body || typeof body !== "object") return body;
  const sanitized = { ...body };
  for (const key of Object.keys(sanitized)) {
    if (SENSITIVE_FIELDS.has(key)) {
      sanitized[key] = "[REDACTED]";
    }
  }
  return sanitized;
}

/**
 * API Request Logging Middleware
 * Logs all incoming API requests with endpoint, method, query params, and body.
 * Sensitive fields (passwords, tokens) are redacted from logs.
 */
export const apiLogger = (req, res, next) => {
  const startTime = Date.now();

  // Log incoming request (with sanitised body)
  const requestData = {
    method: req.method,
    endpoint: req.path,
    queryParams: Object.keys(req.query).length > 0 ? req.query : null,
    body: req.body && Object.keys(req.body).length > 0 ? sanitizeBody(req.body) : null,
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
