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
import { logger } from "./utils/logger.js";
import dotenv from "dotenv";

// quiet: the dotenv v17 banner prints once per process, which is pure noise
// when the cluster forks 16 workers.
dotenv.config({ quiet: true });

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const ROOM_ID_MAX_LENGTH = 200;

// Benchmark-friendly configuration.
// SKIP_DB_CONNECT=true boots the HTTP layer with no MongoDB at all, which is
// what you want when measuring the ceiling of the Node/Express stack.
const SKIP_DB_CONNECT = process.env.SKIP_DB_CONNECT === "true";
const ENABLE_DEPOSIT_WATCHER = process.env.ENABLE_DEPOSIT_WATCHER !== "false";

const KEEP_ALIVE_TIMEOUT_MS = Number(process.env.KEEP_ALIVE_TIMEOUT_MS) || 72_000;
const HEADERS_TIMEOUT_MS =
  Number(process.env.HEADERS_TIMEOUT_MS) || KEEP_ALIVE_TIMEOUT_MS + 1_000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 300_000;
const LISTEN_BACKLOG = Number(process.env.LISTEN_BACKLOG) || 4096;

// Per-socket-event console logging is noise (and I/O) under load tests.
const LOG_SOCKET_EVENTS = process.env.LOG_SOCKET_EVENTS !== "false";

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

  if (SKIP_DB_CONNECT) {
    console.warn(
      "[Startup] SKIP_DB_CONNECT=true - MongoDB is not connected. " +
        "DB-backed endpoints and /ready will fail; /health still works.",
    );
  } else {
    await connectDB(); // connect to MongoDB first
  }

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
    if (LOG_SOCKET_EVENTS) {
      console.log(`[Socket.IO] Authenticated client connected: ${socket.id}`);
    }

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
        if (LOG_SOCKET_EVENTS) {
          console.log(`[Socket.IO] ${socket.id} joined address room`);
        }
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
        if (LOG_SOCKET_EVENTS) {
          console.log(`[Socket.IO] ${socket.id} joined escrow room`);
        }
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
        if (LOG_SOCKET_EVENTS) {
          console.log(`[Socket.IO] ${socket.id} joined chat room`);
        }
      } catch (error) {
        console.error("[Socket.IO] Failed chat subscription:", error.message);
        socket.emit("subscribe:error", { message: "Failed to subscribe" });
      }
    });

    socket.on("disconnect", () => {
      if (LOG_SOCKET_EVENTS) {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
      }
    });
  });

  // Setup chat message handling via Socket.IO
  setupChatSocket(io);

  // Setup native WebSocket endpoint for admin live feed
  setupAdminLiveFeedWs(httpServer);

  // Start MongoDB Change Stream watchers for deposit detection
  if (ENABLE_DEPOSIT_WATCHER && !SKIP_DB_CONNECT) {
    try {
      startDepositWatcher(io);
    } catch (err) {
      console.error("[DepositWatcher] Failed to start:", err.message);
      console.error("  ➜ Change Streams require a MongoDB replica set or Atlas cluster.");
    }
  }

  // --- HTTP server tuning -------------------------------------------------
  // Keep-alive is what allows a load generator to reuse sockets instead of
  // burning ephemeral ports and TCP handshakes. These must stay above the
  // keep-alive timeout of any reverse proxy in front of the app.
  httpServer.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  // Never force a client to re-open a connection mid-benchmark.
  httpServer.maxRequestsPerSocket = 0;

  // Fail fast and legibly when the port is taken: the default Node behaviour is
  // an unhandled 'error' event with a stack trace, and under the cluster
  // entrypoint that turns into a restart loop that hides the real cause.
  // Exit code 78 (EX_CONFIG) tells src/cluster.js not to restart this worker.
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[Fatal] Port ${PORT} is already in use (another server, or a stale worker).\n` +
          `  ➜ Find it:  Get-NetTCPConnection -LocalPort ${PORT} -State Listen\n` +
          `  ➜ Or pick another port:  $env:PORT="${PORT + 1}"; npm run start:cluster`,
      );
      process.exit(78);
    }

    if (err.code === "EACCES") {
      console.error(`[Fatal] Not allowed to bind ${HOST}:${PORT} (privileged port?).`);
      process.exit(78);
    }

    throw err;
  });

  httpServer.listen(PORT, HOST, LISTEN_BACKLOG, () => {
    console.log(
      `Server running on http://${HOST}:${PORT} (pid ${process.pid}) | ` +
        `rateLimit=${process.env.RATE_LIMIT_ENABLED === "true" ? "on" : "off"} | ` +
        `requestLogging=${process.env.REQUEST_LOGGING === "false" ? "off" : "on"} | ` +
        `db=${SKIP_DB_CONNECT ? "skipped" : "connected"}`,
    );
  });

  // --- Graceful shutdown (keeps benchmark numbers clean) ------------------
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Shutdown] ${signal} received, draining connections...`);
    io.close();
    httpServer.close(() => {
      logger.close();
      process.exit(0);
    });
    // Hard exit if connections refuse to drain.
    setTimeout(() => process.exit(0), 5_000).unref?.();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch((error) => {
  console.error("Server startup failed:", error);
  // Missing JWT_SECRET / bad configuration will never fix itself by restarting,
  // so signal that to the cluster supervisor with EX_CONFIG (78).
  process.exit(78);
});
