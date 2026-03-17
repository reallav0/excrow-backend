import { getDB } from "../config/db.js";

const COLLECTION = "sessions";

/**
 * Create a new session (with optional refresh token)
 */
export async function createSession({ sessionId, userId, refreshToken, ip, userAgent, expiresAt }) {
  const db = getDB();

  // Safety check: expiresAt must be a Date
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);

  const session = {
    sessionId,     // string (random ID or part of token)
    userId,        // number (auto-increment)
    refreshToken: refreshToken || null,
    ip,
    userAgent,
    createdAt: new Date(),
    expiresAt: expiry,
    valid: true,
  };

  // Ensure indexes for fast lookups
  await db.collection(COLLECTION).createIndex({ sessionId: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ userId: 1 });
  await db.collection(COLLECTION).createIndex({ refreshToken: 1 }, { sparse: true });

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
 * Find a valid session by its refresh token
 */
export async function findByRefreshToken(refreshToken) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ refreshToken, valid: true });
}

/**
 * Rotate the refresh token for a session (prevents reuse attacks)
 */
export async function rotateRefreshToken(sessionId, newRefreshToken) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { sessionId },
    { $set: { refreshToken: newRefreshToken } }
  );
}

/**
 * Invalidate a session (logout)
 */
export async function invalidateSession(sessionId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { sessionId },
    { $set: { valid: false, refreshToken: null } }
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
    { $set: { valid: false, refreshToken: null } }
  );
}
