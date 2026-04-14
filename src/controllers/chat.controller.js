/**
 * Escrow Chat Controller
 *
 * REST endpoints for chat history & mark-as-read.
 * Real-time send/receive is handled via Socket.IO in index.js.
 *
 * Routes (mounted at /api/escrow/chat):
 *   GET  /:escrowId/messages   – paginated message history
 *   POST /:escrowId/read       – mark messages as read
 *   GET  /:escrowId/unread     – unread count
 */

import express from "express";
import { findByEscrowId } from "../models/Escrow.js";
import { getMessages, markAsRead, countUnread } from "../models/EscrowChat.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();

/**
 * Middleware: verify the user is buyer or seller in the escrow
 */
async function authorizeEscrowParty(req, res, next) {
  const { escrowId } = req.params;
  if (!escrowId) {
    return res.status(400).json({ message: "Escrow ID is required" });
  }

  const escrow = await findByEscrowId(escrowId);
  if (!escrow) {
    return res.status(404).json({ message: "Escrow not found" });
  }

  const buyerId = escrow.buyer?.userId;
  const sellerId = escrow.seller?.userId;

  if (req.user.userId !== buyerId && req.user.userId !== sellerId) {
    return res.status(403).json({ message: "You don't have access to this escrow chat" });
  }

  req.escrow = escrow;
  next();
}

// Apply auth to all routes
router.use(authenticate);

/* ===================== GET MESSAGE HISTORY ===================== */
router.get("/:escrowId/messages", authorizeEscrowParty, async (req, res) => {
  try {
    const { escrowId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before || null; // cursor-based pagination

    const messages = await getMessages(escrowId, limit, before);

    res.status(200).json({ messages });
  } catch (error) {
    console.error("Get Chat Messages Error:", error);
    res.status(500).json({ message: "Error retrieving messages" });
  }
});

/* ===================== MARK AS READ ===================== */
router.post("/:escrowId/read", authorizeEscrowParty, async (req, res) => {
  try {
    const { escrowId } = req.params;
    await markAsRead(escrowId, req.user.userId);

    // Notify the other party that messages were read
    const io = req.app.get("io");
    if (io) {
      io.to(`chat:${escrowId}`).emit("chat:read", {
        escrowId,
        readBy: req.user.userId,
      });
    }

    res.status(200).json({ message: "Messages marked as read" });
  } catch (error) {
    console.error("Mark As Read Error:", error);
    res.status(500).json({ message: "Error marking messages as read" });
  }
});

/* ===================== UNREAD COUNT ===================== */
router.get("/:escrowId/unread", authorizeEscrowParty, async (req, res) => {
  try {
    const { escrowId } = req.params;
    const count = await countUnread(escrowId, req.user.userId);

    res.status(200).json({ unread: count });
  } catch (error) {
    console.error("Unread Count Error:", error);
    res.status(500).json({ message: "Error counting unread messages" });
  }
});

export default router;
