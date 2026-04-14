import { getDB } from "../config/db.js";

const COLLECTION = "userprofiles";
const PROFILE_VISIBILITY_OPTIONS = new Set(["public", "private", "friends_only"]);

const DEFAULT_USER_SETTINGS = {
  notifications: {
    emailNotifications: true,
    pushNotifications: true,
    marketingEmails: false,
    escrowUpdates: true,
  },
  privacy: {
    profileVisibility: "public",
    showEmail: false,
    allowMessages: true,
  },
  security: {
    twoFactorAuth: false,
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boolOrDefault(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function getDefaultUserSettings() {
  return deepClone(DEFAULT_USER_SETTINGS);
}

export function normalizeUserSettings(input = {}) {
  const defaults = getDefaultUserSettings();
  const candidate = input && typeof input === "object" ? input : {};

  const incomingNotifications =
    candidate.notifications && typeof candidate.notifications === "object"
      ? candidate.notifications
      : {};
  const incomingPrivacy =
    candidate.privacy && typeof candidate.privacy === "object"
      ? candidate.privacy
      : {};
  const incomingSecurity =
    candidate.security && typeof candidate.security === "object"
      ? candidate.security
      : {};

  const visibility =
    typeof incomingPrivacy.profileVisibility === "string" &&
    PROFILE_VISIBILITY_OPTIONS.has(incomingPrivacy.profileVisibility)
      ? incomingPrivacy.profileVisibility
      : defaults.privacy.profileVisibility;

  return {
    notifications: {
      emailNotifications: boolOrDefault(
        incomingNotifications.emailNotifications,
        defaults.notifications.emailNotifications
      ),
      pushNotifications: boolOrDefault(
        incomingNotifications.pushNotifications,
        defaults.notifications.pushNotifications
      ),
      marketingEmails: boolOrDefault(
        incomingNotifications.marketingEmails,
        defaults.notifications.marketingEmails
      ),
      escrowUpdates: boolOrDefault(
        incomingNotifications.escrowUpdates,
        defaults.notifications.escrowUpdates
      ),
    },
    privacy: {
      profileVisibility: visibility,
      showEmail: boolOrDefault(incomingPrivacy.showEmail, defaults.privacy.showEmail),
      allowMessages: boolOrDefault(
        incomingPrivacy.allowMessages,
        defaults.privacy.allowMessages
      ),
    },
    security: {
      twoFactorAuth: boolOrDefault(
        incomingSecurity.twoFactorAuth,
        defaults.security.twoFactorAuth
      ),
    },
  };
}


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

    settings: getDefaultUserSettings(),

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
  "settings",
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