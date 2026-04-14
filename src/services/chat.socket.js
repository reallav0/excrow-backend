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

import { findBySessionId } from "../models/SessionStore.js";
import { findByUserId } from "../models/User.js";
import { findByEscrowId } from "../models/Escrow.js";
import { saveMessage } from "../models/EscrowChat.js";

function isEscrowParty(userId, escrow) {
  const buyerId = escrow?.buyer?.userId;
  const sellerId = escrow?.seller?.userId;
  return String(userId) === String(buyerId) || String(userId) === String(sellerId);
}

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

        const userId = socket.data?.userId;
        const sessionId = socket.data?.sessionId;
        if (userId === undefined || userId === null || !sessionId) {
          return socket.emit("chat:error", { message: "Not authenticated" });
        }

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

        if (!isEscrowParty(userId, escrow)) {
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
    socket.on("chat:typing", async (data) => {
      const escrowId = typeof data?.escrowId === "string" ? data.escrowId.trim() : "";
      const userId = socket.data?.userId;
      if (!escrowId || userId === undefined || userId === null) {
        return;
      }

      const escrow = await findByEscrowId(escrowId);
      if (!escrow || !isEscrowParty(userId, escrow)) {
        return;
      }

      socket.to(`chat:${escrowId}`).emit("chat:typing", { escrowId, userId });
    });

    socket.on("chat:stopTyping", async (data) => {
      const escrowId = typeof data?.escrowId === "string" ? data.escrowId.trim() : "";
      const userId = socket.data?.userId;
      if (!escrowId || userId === undefined || userId === null) {
        return;
      }

      const escrow = await findByEscrowId(escrowId);
      if (!escrow || !isEscrowParty(userId, escrow)) {
        return;
      }

      socket.to(`chat:${escrowId}`).emit("chat:stopTyping", { escrowId, userId });
    });
  });
}
