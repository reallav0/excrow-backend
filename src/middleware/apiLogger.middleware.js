import { logger } from "../utils/logger.js";
import { getClientIp } from "../utils/clientIp.js";

/**
 * Request logging middleware.
 *
 * Performance knobs (all optional):
 *   REQUEST_LOGGING=false          disable request logging entirely (zero overhead)
 *   REQUEST_LOG_SAMPLE_RATE=0.01   log 1% of requests (0 disables, 1 logs everything)
 *
 * The middleware never touches `res.send`, so a disabled logger costs one
 * comparison per request.
 */

const REQUEST_LOGGING_ENABLED = process.env.REQUEST_LOGGING !== "false";

const parsedSampleRate = Number.parseFloat(process.env.REQUEST_LOG_SAMPLE_RATE ?? "");
const REQUEST_LOG_SAMPLE_RATE = Number.isFinite(parsedSampleRate)
  ? Math.min(Math.max(parsedSampleRate, 0), 1)
  : 1;

// Health/benchmark probes are hit constantly and carry no signal.
const IGNORED_PATHS = new Set([
  "/health",
  "/healthz",
  "/livez",
  "/ready",
  "/readyz",
  "/api/health",
  "/api/ready",
  "/favicon.ico",
]);

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
 * Logs incoming API requests and their response status/duration.
 */
export const apiLogger = (req, res, next) => {
  if (!REQUEST_LOGGING_ENABLED || REQUEST_LOG_SAMPLE_RATE <= 0) {
    return next();
  }

  const path = req.path;
  if (IGNORED_PATHS.has(path)) {
    return next();
  }

  if (REQUEST_LOG_SAMPLE_RATE < 1 && Math.random() >= REQUEST_LOG_SAMPLE_RATE) {
    return next();
  }

  const startTime = Date.now();

  const requestData = {
    method: req.method,
    endpoint: path,
    queryParams: Object.keys(req.query).length > 0 ? req.query : null,
    body: req.body && Object.keys(req.body).length > 0 ? sanitizeBody(req.body) : null,
    ip: getClientIp(req),
    userAgent: req.headers["user-agent"],
  };

  logger.api(
    req.method,
    path,
    "INCOMING",
    requestData.body || requestData.queryParams || null,
  );

  // Log the response once it is actually flushed to the socket.
  res.once("finish", () => {
    logger.api(req.method, path, res.statusCode, {
      duration: `${Date.now() - startTime}ms`,
    });
  });

  return next();
};

export default apiLogger;
