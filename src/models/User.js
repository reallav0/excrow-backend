import bcrypt from "bcrypt";
import { getDB } from "../config/db.js";
import { createData } from "../models/Data.js"
const COLLECTION = "users";

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

  // Check if email exists
  const existing = await db.collection(COLLECTION).findOne({ email });
  if (existing) throw new Error("Email already in use");

  const userId = await getNextUserId(db);
  const passwordHash = await bcrypt.hash(password, 10);
  
  const userDoc = {
    userId,
    email,
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
      facebook: null,
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

  // Example `data`:
  // { email, providerId, username, avatar }

  let user = await db.collection(COLLECTION).findOne({ email: data.email });

  // If user does NOT exist ➜ create new OAuth user
  if (!user) {
    const userId = await getNextUserId(db);

    const newUser = {
      userId,
      email: data.email,
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
        facebook: null,
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
      email: data.email,
      avatar: data.avatar,
      username: data.username,
    };

    await db.collection(COLLECTION).insertOne(newUser);
     await createData({userId})
    return newUser;
  }

  // If EXISTS ➜ link provider
  await db.collection(COLLECTION).updateOne(
    { email: data.email },
    {
      $set: {
        [`providers.${provider}`]: {
          id: data.providerId,
          email: data.email,
          avatar: data.avatar,
          username: data.username,
        },
        updatedAt: new Date(),
      },
    }
  );
  
  return await db.collection(COLLECTION).findOne({ email: data.email });
}

/* ------------------------
   BASIC FINDERS
------------------------- */
export async function findByEmail(email) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ email });
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
   UPDATE FIELDS
------------------------- */
export async function updateUser(userId, updates) {
  const db = getDB();

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
