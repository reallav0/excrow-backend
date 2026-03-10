import express from "express";
import cookieParser from "cookie-parser";
import passport from "passport";
import authRoutes from "./controllers/auth.controller.js"; // ← Import your route file
import userRoutes from "./controllers/user.controller.js"; 
import escrowRoutes from "./controllers/escrow.controller.js";
import chatRoutes from "./controllers/chat.controller.js";
import cors from 'cors';
import { apiLogger } from "./middleware/apiLogger.middleware.js";
import { authRateLimit, apiRateLimit, userRateLimit } from "./middleware/rateLimit.middleware.js";
const app = express();

// Middlewares
app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(passport.initialize());
app.use(cors({
  origin: 'http://localhost:3000', // Replace with your frontend URL
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
app.use("/api", userRateLimit); // User endpoints
app.use("/api", userRoutes);

export default app;
