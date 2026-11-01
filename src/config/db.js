// src/config/database.js
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const uri = process.env.MONGO_URI;
const dbName = "number0";

let db = null;
let client = null;

export async function connectDB() {
  if (!uri) {
    console.error("❌ MONGO_URI is missing in environment configuration");
    process.exit(1);
  }

  try {
    client = new MongoClient(uri, {
      // A bigger pool keeps DB-backed endpoints alive under load tests.
      maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE) || 50,
      minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE) || 0,
      serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 10_000,
    });
    await client.connect();

    db = client.db(dbName);

    console.log(` Connected to MongoDB database: ${dbName}`);
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
}

export function getDB() {
  if (!db) {
    throw new Error("❌ Database not initialized. Call connectDB() first.");
  }
  return db;
}

export function getClient() {
  if (!client) {
    throw new Error("❌ MongoClient not initialized. Call connectDB() first.");
  }
  return client;
}

