/**
 * EscrowChat Model
 *
 * Stores chat messages between buyer and seller within an escrow.
 * Each document is a single message tied to an escrowId.
 *
 * Collection: escrow_chats
 */

import { getDB } from "../config/db.js";
import { ObjectId } from "mongodb";

const COLLECTION = "escrow_chats";

/**
 * Ensure indexes exist (call once at startup or on first use).
 */
let indexesCreated = false;
async function ensureIndexes() {
  if (indexesCreated) return;
  const db = getDB();
  await db.collection(COLLECTION).createIndex({ escrowId: 1, createdAt: 1 });
  indexesCreated = true;
}

/**
 * Save a new chat message.
 * @returns {object} The inserted message document
 */
export async function saveMessage({ escrowId, userId, email, text }) {
  await ensureIndexes();
  const db = getDB();

  const message = {
    _id: new ObjectId(),
    escrowId,
    userId,
    email,
    text: text.trim(),
    read: false,
    createdAt: new Date(),
  };

  await db.collection(COLLECTION).insertOne(message);
  return message;
}

/**
 * Get paginated chat history for an escrow.
 * Returns newest-first, so the frontend can reverse or append.
 *
 * @param {string}  escrowId
 * @param {number}  [limit=50]
 * @param {string}  [before]   – ObjectId string cursor; fetch messages older than this
 * @returns {object[]}
 */
export async function getMessages(escrowId, limit = 50, before = null) {
  await ensureIndexes();
  const db = getDB();

  const query = { escrowId };
  if (before) {
    query._id = { $lt: new ObjectId(before) };
  }

  return db
    .collection(COLLECTION)
    .find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(limit, 100))
    .toArray();
}

/**
 * Mark all messages in an escrow as read for a given user.
 * (i.e. mark messages NOT sent by this user as read)
 */
export async function markAsRead(escrowId, userId) {
  const db = getDB();
  return db.collection(COLLECTION).updateMany(
    { escrowId, userId: { $ne: userId }, read: false },
    { $set: { read: true } }
  );
}

/**
 * Count unread messages in an escrow for a given user.
 */
export async function countUnread(escrowId, userId) {
  const db = getDB();
  return db.collection(COLLECTION).countDocuments({
    escrowId,
    userId: { $ne: userId },
    read: false,
  });
}

/**
 * Delete all chat messages for an escrow (e.g. on escrow expiry/cleanup).
 */
export async function deleteMessages(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).deleteMany({ escrowId });
}
