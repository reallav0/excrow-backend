import { getDB } from "../config/db.js";

const COLLECTION = "sessions";

/**
 * Create a new session
 */
export async function createSession({ sessionId, userId, ip, userAgent, expiresAt }) {
  const db = getDB();

  // Safety check: expiresAt must be a Date
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);

  const session = {
    sessionId,     // string (random ID or part of token)
    userId,        // number (auto-increment)
    ip,
    userAgent,
    createdAt: new Date(),
    expiresAt: expiry,
    valid: true,
  };

  // Ensure index for fast session lookup
  await db.collection(COLLECTION).createIndex({ sessionId: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ userId: 1 });

  await db.collection(COLLECTION).insertOne(session);
  return session;
}

/**
 * Find a session by sessionId
 */
export async function findBySessionId(sessionId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ sessionId });
}

/**
 * Invalidate a session (logout)
 */
export async function invalidateSession(sessionId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { sessionId },
    { $set: { valid: false } }
  );
}

/**
 * Remove all expired sessions
 */
export async function removeExpiredSessions() {
  const db = getDB();
  return db.collection(COLLECTION).deleteMany({
    expiresAt: { $lt: new Date() },
  });
}

/**
 * Invalidate ALL sessions for a user (e.g., global logout)
 */
export async function invalidateAllUserSessions(userId) {
  const db = getDB();
  return db.collection(COLLECTION).updateMany(
    { userId },
    { $set: { valid: false } }
  );
}
