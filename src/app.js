import express from "express";
import cookieParser from "cookie-parser";
import passport from "passport";
import helmet from "helmet";
import authRoutes from "./controllers/auth.controller.js";
import userRoutes from "./controllers/user.controller.js"; 
import transactionRoutes from "./controllers/transaction.controller.js";
import notificationRoutes from "./controllers/notification.controller.js";
import escrowRoutes from "./controllers/escrow.controller.js";
import chatRoutes from "./controllers/chat.controller.js";
import adminRoutes from "./controllers/admin.controller.js";
import platformRoutes from "./controllers/platform.controller.js";
import cors from 'cors';
import { apiLogger } from "./middleware/apiLogger.middleware.js";
import { authRateLimit, apiRateLimit, userRateLimit, publicRateLimit, statusRateLimit } from "./middleware/rateLimit.middleware.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import healthRoutes from "./routes/health.routes.js";

const app = express();

// No "X-Powered-By: Express" header (less work per response, less fingerprinting).
app.disable("x-powered-by");

// Express computes a weak ETag (MD5 of the body) for every response by default.
// That is pure CPU cost for a JSON API consumed by fetch/axios clients, both of
// which ignore it here. Re-enable with HTTP_ETAG=true if a CDN depends on it.
app.set("etag", process.env.HTTP_ETAG === "true");

// The app only uses flat query keys (no `filter[x]=y` bracket syntax), so the
// lighter-weight querystring parser is enough and is faster than `qs`.
app.set("query parser", "simple");

function resolveTrustProxySetting() {
	const configured = process.env.TRUST_PROXY?.trim();
	if (!configured) {
		// Default to trusting proxy headers for reverse-proxy deployments.
		return true;
	}

	if (configured === "true") return true;
	if (configured === "false") return false;

	if (/^\d+$/.test(configured)) {
		return Number(configured);
	}

	return configured;
}

app.set("trust proxy", resolveTrustProxySetting());

const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:3000")
	.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const corsOptions = {
	origin(origin, callback) {
		if (!origin || allowedOrigins.includes(origin)) {
			return callback(null, true);
		}

		return callback(new Error("CORS origin not allowed"));
	},
	credentials: true,
};

// Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
app.use(helmet());

// Body parsing with size limits to prevent large-payload attacks
const BODY_LIMIT = process.env.JSON_BODY_LIMIT || "10kb";

app.use(express.json({ limit: BODY_LIMIT }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
app.use(passport.initialize());
app.use(cors(corsOptions));

// Health / readiness probes come first: no request logging, no auth, no DB
// (except /ready), no rate limiting. GET /health is the benchmark target.
app.use("/", healthRoutes);
app.use("/api", healthRoutes);

// API Request Logging Middleware
app.use(apiLogger);

// Rate Limiting Middleware
//
// Every limiter below is a no-op unless RATE_LIMIT_ENABLED=true, so load tests
// and benchmarks are never rejected with 429s. Flip that env var to restore the
// original production limits.
app.use("/api/auth", authRateLimit); // Stricter limits for auth
app.use("/api/auth", authRoutes);
app.use("/api/escrow", apiRateLimit); // Standard API limits
app.use("/api/escrow", escrowRoutes);
app.use("/api/escrow/chat", apiRateLimit);
app.use("/api/escrow/chat", chatRoutes);
// Mount escrow routes on /api/escrows path as well for GET /api/escrows
app.use("/api/escrows", escrowRoutes);
app.use("/api/platform/status", statusRateLimit);
app.use(
	"/api/platform",
	(req, res, next) => {
		// /status has its own stricter limiter above.
		if (req.path === "/status" || req.path === "/status/") {
			return next();
		}

		return publicRateLimit(req, res, next);
	},
	platformRoutes,
);
app.use("/api/admin", adminRoutes);
app.use("/api", userRateLimit); // User endpoints
app.use("/api", userRoutes);
app.use("/api", transactionRoutes);
app.use("/api", notificationRoutes);

// Error handling (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
