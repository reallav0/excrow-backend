// src/index.js
import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import app from "./app.js";
import { connectDB, getDB } from "./config/db.js";
import { findBySessionId } from "./models/SessionStore.js";
import { findByEscrowId } from "./models/Escrow.js";
import { startDepositWatcher } from "./services/depositWatcher.service.js";
import { setupChatSocket } from "./services/chat.socket.js";
import { setupAdminLiveFeedWs } from "./services/adminLiveFeed.service.js";
import dotenv from "dotenv";

dotenv.config({ path: "../.env" });

const PORT = Number(process.env.PORT) || 3001;
const ROOM_ID_MAX_LENGTH = 200;

function parseCookieHeader(cookieHeader) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) {
    return {};
  }

  return cookieHeader.split(";").reduce((acc, part) => {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName) return acc;
    acc[rawName] = decodeURIComponent(rawValue.join("="));
    return acc;
  }, {});
}

function extractSocketToken(socket) {
  const authHeader = socket.handshake.headers?.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (token) return token;
  }

  const cookies = parseCookieHeader(socket.handshake.headers?.cookie);
  return cookies.accessToken || null;
}

function normalizeRoomId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > ROOM_ID_MAX_LENGTH) return null;
  return normalized;
}

function isEscrowParty(userId, escrow) {
  const buyerId = escrow?.buyer?.userId ?? escrow?.buyerId;
  const sellerId = escrow?.seller?.userId ?? escrow?.sellerId;
  return String(userId) === String(buyerId) || String(userId) === String(sellerId);
}

async function canAccessEscrow(userId, escrowId) {
  const escrow = await findByEscrowId(escrowId);
  if (!escrow) return false;
  return isEscrowParty(userId, escrow);
}

async function canAccessAddress(userId, address) {
  const db = getDB();
  const escrow = await db.collection("escrows").findOne({
    $or: [{ "financials.depositAddress": address }, { depositAddress: address }],
  });

  if (!escrow) return false;
  return isEscrowParty(userId, escrow);
}

function getAllowedOrigins() {
  return (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function startServer() {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set");
  }

  await connectDB(); // connect to MongoDB first

  const httpServer = createServer(app);
  const allowedOrigins = getAllowedOrigins();

  // Initialise Socket.IO
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        return callback(new Error("CORS origin not allowed"));
      },
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = extractSocketToken(socket);
      if (!token) {
        return next(new Error("Not authenticated"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded?.sessionId || decoded?.userId === undefined || decoded?.userId === null) {
        return next(new Error("Invalid token"));
      }

      const session = await findBySessionId(decoded.sessionId);
      if (!session || !session.valid || session.expiresAt < new Date()) {
        return next(new Error("Session expired"));
      }

      socket.data.userId = decoded.userId;
      socket.data.sessionId = decoded.sessionId;
      return next();
    } catch {
      return next(new Error("Not authenticated"));
    }
  });

  // Make io accessible from Express routes (req.app.get("io"))
  app.set("io", io);

  // Socket.IO connection handling
  io.on("connection", (socket) => {
    console.log(`[Socket.IO] Authenticated client connected: ${socket.id}`);

    // Let clients subscribe to a specific address room
    socket.on("subscribe:address", async (rawAddress) => {
      const address = normalizeRoomId(rawAddress);
      if (!address) {
        return socket.emit("subscribe:error", { message: "Invalid address room" });
      }

      try {
        const authorized = await canAccessAddress(socket.data.userId, address);
        if (!authorized) {
          return socket.emit("subscribe:error", { message: "Unauthorized room subscription" });
        }

        socket.join(`address:${address}`);
        console.log(`[Socket.IO] ${socket.id} joined address room`);
      } catch (error) {
        console.error("[Socket.IO] Failed address subscription:", error.message);
        socket.emit("subscribe:error", { message: "Failed to subscribe" });
      }
    });

    // Let clients subscribe to an escrow room
    socket.on("subscribe:escrow", async (rawEscrowId) => {
      const escrowId = normalizeRoomId(rawEscrowId);
      if (!escrowId) {
        return socket.emit("subscribe:error", { message: "Invalid escrow room" });
      }

      try {
        const authorized = await canAccessEscrow(socket.data.userId, escrowId);
        if (!authorized) {
          return socket.emit("subscribe:error", { message: "Unauthorized room subscription" });
        }

        socket.join(`escrow:${escrowId}`);
        console.log(`[Socket.IO] ${socket.id} joined escrow room`);
      } catch (error) {
        console.error("[Socket.IO] Failed escrow subscription:", error.message);
        socket.emit("subscribe:error", { message: "Failed to subscribe" });
      }
    });

    // Let clients subscribe to a chat room for an escrow
    socket.on("subscribe:chat", async (rawEscrowId) => {
      const escrowId = normalizeRoomId(rawEscrowId);
      if (!escrowId) {
        return socket.emit("subscribe:error", { message: "Invalid chat room" });
      }

      try {
        const authorized = await canAccessEscrow(socket.data.userId, escrowId);
        if (!authorized) {
          return socket.emit("subscribe:error", { message: "Unauthorized room subscription" });
        }

        socket.join(`chat:${escrowId}`);
        console.log(`[Socket.IO] ${socket.id} joined chat room`);
      } catch (error) {
        console.error("[Socket.IO] Failed chat subscription:", error.message);
        socket.emit("subscribe:error", { message: "Failed to subscribe" });
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

startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exit(1);
});
