import express from "express";
import cookieParser from "cookie-parser";
import passport from "passport";
import helmet from "helmet";
import authRoutes from "./controllers/auth.controller.js";
import userRoutes from "./controllers/user.controller.js"; 
import escrowRoutes from "./controllers/escrow.controller.js";
import chatRoutes from "./controllers/chat.controller.js";
import adminRoutes from "./controllers/admin.controller.js";
import platformRoutes from "./controllers/platform.controller.js";
import cors from 'cors';
import { apiLogger } from "./middleware/apiLogger.middleware.js";
import { authRateLimit, apiRateLimit, userRateLimit } from "./middleware/rateLimit.middleware.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";

const app = express();

// Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
app.use(helmet());

// Body parsing with size limits to prevent large-payload attacks
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(passport.initialize());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// API Request Logging Middleware
app.use(apiLogger);

// Rate Limiting Middleware
app.use("/api/auth", authRateLimit); // Stricter limits for auth
app.use("/api/auth", authRoutes);
app.use("/api/escrow", apiRateLimit); // Standard API limits
app.use("/api/escrow", escrowRoutes);
app.use("/api/escrow/chat", apiRateLimit);
app.use("/api/escrow/chat", chatRoutes);
// Mount escrow routes on /api/escrows path as well for GET /api/escrows
app.use("/api/escrows", escrowRoutes);
app.use("/api/platform", platformRoutes);
app.use("/api/admin", apiRateLimit);
app.use("/api/admin", adminRoutes);
app.use("/api", userRateLimit); // User endpoints
app.use("/api", userRoutes);

// Error handling (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
