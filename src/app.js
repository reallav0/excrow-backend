import express from "express";
import cookieParser from "cookie-parser";
import passport from "passport";
import authRoutes from "./controllers/auth.controller.js"; // ← Import your route file
import userRoutes from "./controllers/user.controller.js"; 
import escrowRoutes from "./controllers/escrow.controller.js";// ← Import user routes
import cors from 'cors';
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
app.use("/api/auth", authRoutes); // ← Mount as /api/auth/login, /register
app.use("/api", userRoutes); // ← Mount user routes
app.use("/api/escrow", escrowRoutes)

export default app;
