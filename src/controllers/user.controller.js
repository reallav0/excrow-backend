import express from "express";
import { findByUserId } from "../models/User.js";
import {
  createData,
  fetchDataByUserId,
  getDefaultUserSettings,
  normalizeUserSettings,
  updateUserProfile,
} from "../models/Data.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();
const PROFILE_VISIBILITY_OPTIONS = new Set(["public", "private", "friends_only"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSettingsPayload(payload) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return { valid: false, errors: ["Request body must be an object"] };
  }

  const allowedTopLevel = new Set(["notifications", "privacy", "security"]);
  for (const key of Object.keys(payload)) {
    if (!allowedTopLevel.has(key)) {
      errors.push(`Unsupported settings group: ${key}`);
    }
  }

  const notificationsKeys = new Set([
    "emailNotifications",
    "pushNotifications",
    "marketingEmails",
    "escrowUpdates",
  ]);
  const privacyKeys = new Set(["profileVisibility", "showEmail", "allowMessages"]);
  const securityKeys = new Set(["twoFactorAuth"]);

  if (payload.notifications !== undefined) {
    if (!isPlainObject(payload.notifications)) {
      errors.push("notifications must be an object");
    } else {
      for (const key of Object.keys(payload.notifications)) {
        if (!notificationsKeys.has(key)) {
          errors.push(`Unsupported notifications field: ${key}`);
          continue;
        }
        if (typeof payload.notifications[key] !== "boolean") {
          errors.push(`notifications.${key} must be boolean`);
        }
      }
    }
  }

  if (payload.privacy !== undefined) {
    if (!isPlainObject(payload.privacy)) {
      errors.push("privacy must be an object");
    } else {
      for (const key of Object.keys(payload.privacy)) {
        if (!privacyKeys.has(key)) {
          errors.push(`Unsupported privacy field: ${key}`);
          continue;
        }
        if (key === "profileVisibility") {
          if (
            typeof payload.privacy.profileVisibility !== "string" ||
            !PROFILE_VISIBILITY_OPTIONS.has(payload.privacy.profileVisibility)
          ) {
            errors.push("privacy.profileVisibility must be one of: public, private, friends_only");
          }
          continue;
        }
        if (typeof payload.privacy[key] !== "boolean") {
          errors.push(`privacy.${key} must be boolean`);
        }
      }
    }
  }

  if (payload.security !== undefined) {
    if (!isPlainObject(payload.security)) {
      errors.push("security must be an object");
    } else {
      for (const key of Object.keys(payload.security)) {
        if (!securityKeys.has(key)) {
          errors.push(`Unsupported security field: ${key}`);
          continue;
        }
        if (typeof payload.security[key] !== "boolean") {
          errors.push(`security.${key} must be boolean`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function mergeSettings(currentSettings, updates) {
  return normalizeUserSettings({
    notifications: {
      ...currentSettings.notifications,
      ...(updates.notifications || {}),
    },
    privacy: {
      ...currentSettings.privacy,
      ...(updates.privacy || {}),
    },
    security: {
      ...currentSettings.security,
      ...(updates.security || {}),
    },
  });
}

/* ------------------ GET USER (authenticated) ------------------ */
router.get("/user", authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user data
    const user = await findByUserId(userId);
    if (!user) {
      return res.status(404).json({ logout: true, message: "User not found" });
    }
    const data = await fetchDataByUserId(userId);
    if (!data) {
      return res.status(404).json({ logout: true, message: "Data not found" });
    }

    // Return user data (exclude sensitive info like passwordHash)
    res.json({
      userId: user.userId,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar,
      birthdate: user.birthdate,
      bio: user.bio,
      totalEscrows: data.totalEscrows,
      openingEscrows: data.openingEscrows,
      completedEscrows: data.completedEscrows,
      disputedEscrows: data.disputedEscrows,
      cancelledEscrows: data.cancelledEscrows,
      buyerStats: data.buyerStats,
      sellerStats: data.sellerStats,
    });
  } catch (error) {
    console.error("Get User Error:", error);
    res.status(500).json({ message: "Error retrieving user data" });
  }
});

/* ------------------ GET PUBLIC PROFILE ------------------ */
router.get("/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const userId = parseInt(id);

    // Get user data
    const user = await findByUserId(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const data = await fetchDataByUserId(userId);

    res.json({
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      bio: user.bio,
      completedEscrows: data?.completedEscrows || 0,
      buyerStats: data?.buyerStats || null,
      sellerStats: data?.sellerStats || null,
      reputationScore: data?.reputationScore || 0,
    });
  } catch (error) {
    console.error("Get Profile Error:", error);
    res.status(500).json({ message: "Error retrieving profile data" });
  }
});

/* ------------------ UPDATE USER SETTINGS (authenticated) ------------------ */
router.put("/user/settings", authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    const settingsUpdate = req.body || {};

    const validation = parseSettingsPayload(settingsUpdate);
    if (!validation.valid) {
      return res.status(400).json({ message: validation.errors[0], errors: validation.errors });
    }

    const user = await findByUserId(userId);
    if (!user) {
      return res.status(404).json({ logout: true, message: "User not found" });
    }

    let profile = await fetchDataByUserId(userId);
    if (!profile) {
      profile = await createData({ userId });
    }

    const existingSettings = normalizeUserSettings(profile?.settings || getDefaultUserSettings());
    const mergedSettings = mergeSettings(existingSettings, settingsUpdate);

    await updateUserProfile({
      userId,
      updates: { settings: mergedSettings },
      isInternal: true,
    });

    const updatedProfile = await fetchDataByUserId(userId);
    const responseSettings = normalizeUserSettings(updatedProfile?.settings || mergedSettings);

    return res.status(200).json({
      id: `user_${userId}`,
      notifications: responseSettings.notifications,
      privacy: responseSettings.privacy,
      security: responseSettings.security,
      updatedAt: updatedProfile?.updatedAt || new Date(),
      message: "Settings updated successfully",
    });
  } catch (error) {
    console.error("Update Settings Error:", error);
    return res.status(500).json({ message: "Error updating settings" });
  }
});

export default router;
