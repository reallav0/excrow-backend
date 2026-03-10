/**
 * Chat Socket Handler
 *
 * Handles real-time chat message sending between buyer and seller
 * within an escrow via Socket.IO.
 *
 * Events:
 *   IN  → "chat:send"    { escrowId, text }
 *   OUT → "chat:message"  { _id, escrowId, userId, email, text, read, createdAt }
 *   OUT → "chat:error"    { message }
 */

import jwt from "jsonwebtoken";
import cookie from "cookie";
import { findBySessionId } from "../models/SessionStore.js";
import { findByUserId } from "../models/User.js";
import { findByEscrowId } from "../models/Escrow.js";
import { saveMessage } from "../models/EscrowChat.js";

/**
 * Attach chat event listeners to the Socket.IO server.
 * @param {import("socket.io").Server} io
 */
export function setupChatSocket(io) {
  io.on("connection", (socket) => {

    socket.on("chat:send", async (data) => {
      try {
        const { escrowId, text } = data || {};

        // Validate input
        if (!escrowId || !text || typeof text !== "string" || text.trim().length === 0) {
          return socket.emit("chat:error", { message: "Missing escrowId or text" });
        }

        if (text.trim().length > 2000) {
          return socket.emit("chat:error", { message: "Message too long (max 2000 chars)" });
        }

        // Extract token from cookies
        const cookieHeader = socket.handshake.headers?.cookie;
        if (!cookieHeader) {
          return socket.emit("chat:error", { message: "Not authenticated" });
        }

        const cookies = cookie.parse(cookieHeader);
        const token = cookies.accessToken;
        if (!token) {
          return socket.emit("chat:error", { message: "Not authenticated" });
        }

        // Authenticate via JWT
        let decoded;
        try {
          decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
          return socket.emit("chat:error", { message: "Invalid token" });
        }

        const { sessionId, userId } = decoded;

        // Verify session
        const session = await findBySessionId(sessionId);
        if (!session || !session.valid || session.expiresAt < new Date()) {
          return socket.emit("chat:error", { message: "Session expired" });
        }

        // Verify escrow exists and user is a party
        const escrow = await findByEscrowId(escrowId);
        if (!escrow) {
          return socket.emit("chat:error", { message: "Escrow not found" });
        }

        const buyerId = escrow.buyer?.userId;
        const sellerId = escrow.seller?.userId;

        if (userId !== buyerId && userId !== sellerId) {
          return socket.emit("chat:error", { message: "You are not a party in this escrow" });
        }

        // Get user email
        const user = await findByUserId(userId);
        const email = user?.email || "unknown";

        // Save message to DB
        const message = await saveMessage({
          escrowId,
          userId,
          email,
          text,
        });

        // Auto-join sender to the chat room (in case they haven't subscribed)
        socket.join(`chat:${escrowId}`);

        // Broadcast to everyone in the escrow chat room (including sender)
        io.to(`chat:${escrowId}`).emit("chat:message", message);

      } catch (error) {
        console.error("[ChatSocket] Error handling chat:send:", error);
        socket.emit("chat:error", { message: "Failed to send message" });
      }
    });

    // Typing indicator
    socket.on("chat:typing", (data) => {
      const { escrowId, userId } = data || {};
      if (escrowId && userId) {
        socket.to(`chat:${escrowId}`).emit("chat:typing", { escrowId, userId });
      }
    });

    socket.on("chat:stopTyping", (data) => {
      const { escrowId, userId } = data || {};
      if (escrowId && userId) {
        socket.to(`chat:${escrowId}`).emit("chat:stopTyping", { escrowId, userId });
      }
    });
  });
}
