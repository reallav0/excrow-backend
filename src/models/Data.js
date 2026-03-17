import { getDB } from "../config/db.js";

const COLLECTION = "userprofiles";


export async function createData({ userId }) {
  const db = getDB();
   
  if (!userId) {
    throw new Error("userId is required");
  }

  const now = new Date();

  const defaultProfile = {
    userId,

    // ---- Trust & reputation ----
    reputationScore: 0,
    totalEscrows: 0,
    openingEscrows: 0,
    completedEscrows: 0,
    disputedEscrows: 0,
    cancelledEscrows: 0,

    // ---- Role usage ----
    buyerStats: {
      totalEscrows: 0,
      totalSpentBTC: 0
    },

    sellerStats: {
      totalEscrows: 0,
      totalEarnedBTC: 0
    },

    // ---- Verification ----
    emailVerified: false,
    kycStatus: "none", // none | pending | verified | rejected
    kycVerifiedAt: null,

    // ---- Risk / Anti-fraud ----
    riskScore: 0,
    flagged: false,
    flaggedReason: null,

    // ---- Preferences ----
    preferences: {
      autoReleaseDefaultHours: 72,
      notifications: {
        email: true,
        inApp: true
      }
    },

    // ---- Moderation ----
    banned: false,
    banReason: null,
    bannedAt: null,

    createdAt: now
  };

  const result = await db.collection(COLLECTION).findOneAndUpdate(
    { userId },
    {
      $setOnInsert: defaultProfile, // only when creating
      $set: { updatedAt: now }      // always update timestamp
    },
    {
      upsert: true,
      returnDocument: "after"
    }
  );

  return result.value;
}
const ALLOWED_PROFILE_UPDATES = new Set([
  "preferences",
]);

export async function updateUserProfile({ userId, updates, isInternal = false }) {
  const db = getDB();

  if (!userId) throw new Error("userId is required");
  if (!updates || typeof updates !== "object") {
    throw new Error("updates must be an object");
  }

  // Unless called internally, only allow whitelisted fields
  if (!isInternal) {
    const filtered = {};
    for (const key of Object.keys(updates)) {
      if (ALLOWED_PROFILE_UPDATES.has(key)) {
        filtered[key] = updates[key];
      }
    }
    updates = filtered;
  }

  if (Object.keys(updates).length === 0) {
    return true; // nothing to update
  }

  const result = await db.collection(COLLECTION).updateOne(
    { userId },
    {
      $set: {
        ...updates,
        updatedAt: new Date()
      }
    }
  );

  if (result.matchedCount === 0) {
    throw new Error("User profile not found");
  }

  return true;
}
export async function incrementUserStats({ userId, inc }) {
  const db = getDB();

  await db.collection(COLLECTION).updateOne(
    { userId },
    {
      $inc: inc,
      $set: { updatedAt: new Date() }
    }
  );
}
export async function fetchDataByUserId(userId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ userId });
}