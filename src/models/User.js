import bcrypt from "bcrypt";
import { getDB } from "../config/db.js";
import { createData } from "../models/Data.js"
const COLLECTION = "users";

function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEmailQuery(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return { email: new RegExp(`^${escapeRegex(normalized)}$`, "i") };
}

/* ------------------------
   AUTO-INCREMENT userId
------------------------- */
async function getNextUserId(db) {
  const lastUser = await db
    .collection(COLLECTION)
    .find()
    .sort({ userId: -1 })
    .limit(1)
    .toArray();

  // If no users yet → start at 1
  return lastUser.length === 0 ? 1 : lastUser[0].userId + 1;
}
/* ------------------------
   CREATE LOCAL USER
------------------------- */
export async function createLocalUser({ username, email, password, birthdate }) {
  const db = getDB();
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throw new Error("Email is required");
  }

  // Check if email exists
  const existing = await db.collection(COLLECTION).findOne(buildEmailQuery(normalizedEmail));
  if (existing) throw new Error("Email already in use");

  const userId = await getNextUserId(db);
  const passwordHash = await bcrypt.hash(password, 10);
  
  const userDoc = {
    userId,
    email: normalizedEmail,
    username,
    displayName: username,
    avatar: null,
    birthdate,
    bio: "",

    passwordHash,
    authProvider: "local",

    providers: {
      google: null,
      discord: null,
    },

    token: null,
    refreshToken: null,
    lastLogin: null,

    roles: ["user"],

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.collection(COLLECTION).insertOne(userDoc);

  await createData({ userId })
  return userDoc;
}

/* ------------------------
   CREATE OR LINK OAUTH USER
------------------------- */
export async function createOrUpdateOAuthUser(provider, data) {
  const db = getDB();
  const normalizedEmail = normalizeEmail(data.email);

  if (!normalizedEmail) {
    throw new Error("Email is required for OAuth login");
  }

  // Example `data`:
  // { email, providerId, username, avatar }
  const providerLookupKey = `providers.${provider}.id`;

  let user = await db.collection(COLLECTION).findOne({ [providerLookupKey]: data.providerId });

  if (!user) {
    user = await db.collection(COLLECTION).findOne(buildEmailQuery(normalizedEmail));
  }

  // If user does NOT exist ➜ create new OAuth user
  if (!user) {
    const userId = await getNextUserId(db);

    const newUser = {
      userId,
      email: normalizedEmail,
      username: data.username || provider + "_" + userId,
      displayName: data.username,
      avatar: data.avatar,
      birthdate: null,
      bio: "",

      passwordHash: null,
      authProvider: provider,

      providers: {
        google: null,
        discord: null,
      },

      token: null,
      refreshToken: null,
      lastLogin: new Date(),

      roles: ["user"],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    newUser.providers[provider] = {
      id: data.providerId,
      email: normalizedEmail,
      avatar: data.avatar,
      username: data.username,
    };

    await db.collection(COLLECTION).insertOne(newUser);
     await createData({userId})
    return newUser;
  }

  // If EXISTS ➜ link provider
  await db.collection(COLLECTION).updateOne(
    { userId: user.userId },
    {
      $set: {
        email: normalizedEmail,
        [`providers.${provider}`]: {
          id: data.providerId,
          email: normalizedEmail,
          avatar: data.avatar,
          username: data.username,
        },
        lastLogin: new Date(),
        updatedAt: new Date(),
      },
    }
  );
  
  return await db.collection(COLLECTION).findOne({ userId: user.userId });
}

/* ------------------------
   BASIC FINDERS
------------------------- */
export async function findByEmail(email) {
  const db = getDB();
  const emailQuery = buildEmailQuery(email);
  if (!emailQuery) return null;
  return db.collection(COLLECTION).findOne(emailQuery);
}

export async function findByUsername(username) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ username });
}

export async function findByUserId(userId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ userId });
}

/* ------------------------
   UPDATE FIELDS (with whitelist to prevent privilege escalation)
------------------------- */
const ALLOWED_USER_UPDATES = new Set([
  "username", "displayName", "avatar", "bio", "birthdate",
]);

export async function updateUser(userId, updates, { isInternal = false } = {}) {
  const db = getDB();

  // Unless called internally, only allow whitelisted fields
  if (!isInternal) {
    const filtered = {};
    for (const key of Object.keys(updates)) {
      if (ALLOWED_USER_UPDATES.has(key)) {
        filtered[key] = updates[key];
      }
    }
    updates = filtered;
  }

  if (Object.keys(updates).length === 0) {
    return { modifiedCount: 0 };
  }

  updates.updatedAt = new Date();

  return db.collection(COLLECTION).updateOne(
    { userId },
    { $set: updates }
  );
}

/* ------------------------
   DELETE USER
------------------------- */
export async function deleteUser(userId) {
  const db = getDB();
  return db.collection(COLLECTION).deleteOne({ userId });
}

/* ------------------------
   PASSWORD CHECK
------------------------- */
export async function comparePassword(plain, hashed) {
  return bcrypt.compare(plain, hashed);
}
