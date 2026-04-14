// src/config/database.js
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = "number0";

if (!uri) {
  console.error("❌ MONGO_URI is missing in environment configuration");
  process.exit(1);
}

let db = null;
let client = null;

export async function connectDB() {
  try {
    client = new MongoClient(uri);
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

