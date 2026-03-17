// src/index.js
import { createServer } from "http";
import { Server } from "socket.io";
import app from "./app.js";
import { connectDB } from "./config/db.js";
import { startDepositWatcher } from "./services/depositWatcher.service.js";
import { setupChatSocket } from "./services/chat.socket.js";
import { setupAdminLiveFeedWs } from "./services/adminLiveFeed.service.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT;

async function startServer() {
  await connectDB(); // connect to MongoDB first

  const httpServer = createServer(app);

  // Initialise Socket.IO
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  // Make io accessible from Express routes (req.app.get("io"))
  app.set("io", io);

  // Socket.IO connection handling
  io.on("connection", (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    // Let clients subscribe to a specific address room
    socket.on("subscribe:address", (address) => {
      if (typeof address === "string" && address.length > 0) {
        socket.join(`address:${address}`);
        console.log(`[Socket.IO] ${socket.id} joined address:${address}`);
      }
    });

    // Let clients subscribe to an escrow room
    socket.on("subscribe:escrow", (escrowId) => {
      if (typeof escrowId === "string" && escrowId.length > 0) {
        socket.join(`escrow:${escrowId}`);
        console.log(`[Socket.IO] ${socket.id} joined escrow:${escrowId}`);
      }
    });

    // Let clients subscribe to a chat room for an escrow
    socket.on("subscribe:chat", (escrowId) => {
      if (typeof escrowId === "string" && escrowId.length > 0) {
        socket.join(`chat:${escrowId}`);
        console.log(`[Socket.IO] ${socket.id} joined chat:${escrowId}`);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
  });

  // Setup chat message handling via Socket.IO
  setupChatSocket(io);

  // Setup native WebSocket endpoint for admin live feed
  setupAdminLiveFeedWs(httpServer);

  // Start MongoDB Change Stream watchers for deposit detection
  try {
    startDepositWatcher(io);
  } catch (err) {
    console.error("[DepositWatcher] Failed to start:", err.message);
    console.error("  ➜ Change Streams require a MongoDB replica set or Atlas cluster.");
  }

  httpServer.listen(PORT, () => {
    console.log(" Server running on port", PORT);
  });
}

startServer();
