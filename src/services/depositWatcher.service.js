/**
 * Deposit Watcher Service
 *
 * Uses MongoDB Change Streams to watch the addresses_btc and addresses_ltc
 * collections for deposit updates made by the external block indexer.
 *
 * When a deposit field is set/updated on an address document, this service
 * emits a Socket.IO event so the frontend can react in real-time.
 *
 * Requirements:
 *   - MongoDB must be a replica set or Atlas cluster (change streams need oplog).
 *   - Socket.IO server must be initialised before calling startDepositWatcher().
 */

import { getDB } from "../config/db.js";

const WATCHED_COLLECTIONS = ["addresses_btc", "addresses_ltc"];

/**
 * Start watching both address collections for deposit changes.
 * @param {import("socket.io").Server} io  – initialised Socket.IO server instance
 */
export function startDepositWatcher(io) {
  const db = getDB();

  for (const collName of WATCHED_COLLECTIONS) {
    const collection = db.collection(collName);
    const coin = collName.includes("btc") ? "BTC" : "LTC";

    // Only care about updates that touch the "deposit" field
    const pipeline = [
      {
        $match: {
          operationType: "update",
          $or: [
            { "updateDescription.updatedFields.deposit": { $exists: true } },
            { "updateDescription.updatedFields.confirmed": { $exists: true } },
            { "updateDescription.updatedFields.balance": { $exists: true } },
          ],
        },
      },
    ];

    const changeStream = collection.watch(pipeline, { fullDocument: "updateLookup" });

    changeStream.on("change", (change) => {
      const doc = change.fullDocument;
      if (!doc) return;

      const payload = {
        coin,
        address: doc.address,
        assignedId: doc.assignedId,  // e.g. "escrow_001"
        deposit: doc.deposit,        // { txid, value, blockHeight, ... }
        confirmed: doc.confirmed,
        balance: doc.balance ?? 0,
        updatedAt: doc.updatedAt,
      };

      console.log(`[DepositWatcher] ${coin} deposit detected on ${doc.address}`);

      // Emit to everyone in the room for this specific address
      io.to(`address:${doc.address}`).emit("deposit:update", payload);

      // Also emit to the room for the assigned entity (e.g. escrow)
      if (doc.assignedId) {
        io.to(`escrow:${doc.assignedId}`).emit("deposit:update", payload);
      }

      // Global event any admin dashboard can listen to
      io.to("admin").emit("deposit:update", payload);
    });

    changeStream.on("error", (err) => {
      console.error(`[DepositWatcher] ${coin} change stream error:`, err.message);
      // Restart after a short delay
      setTimeout(() => {
        console.log(`[DepositWatcher] Restarting ${coin} watcher...`);
        startCollectionWatcher(collection, coin, io);
      }, 5000);
    });

    console.log(`[DepositWatcher] Watching ${collName} for deposit changes`);
  }
}

/**
 * Helper to restart a single collection watcher (used on error recovery).
 */
function startCollectionWatcher(collection, coin, io) {
  const pipeline = [
    {
      $match: {
        operationType: "update",
        $or: [
          { "updateDescription.updatedFields.deposit": { $exists: true } },
          { "updateDescription.updatedFields.confirmed": { $exists: true } },
          { "updateDescription.updatedFields.balance": { $exists: true } },
        ],
      },
    },
  ];

  const changeStream = collection.watch(pipeline, { fullDocument: "updateLookup" });

  changeStream.on("change", (change) => {
    const doc = change.fullDocument;
    if (!doc) return;

    const payload = {
      coin,
      address: doc.address,
      assignedId: doc.assignedId,
      deposit: doc.deposit,
      confirmed: doc.confirmed,
      balance: doc.balance ?? 0,
      updatedAt: doc.updatedAt,
    };

    console.log(`[DepositWatcher] ${coin} deposit detected on ${doc.address}`);

    io.to(`address:${doc.address}`).emit("deposit:update", payload);
    if (doc.assignedId) {
      io.to(`escrow:${doc.assignedId}`).emit("deposit:update", payload);
    }
    io.to("admin").emit("deposit:update", payload);
  });

  changeStream.on("error", (err) => {
    console.error(`[DepositWatcher] ${coin} change stream error:`, err.message);
    setTimeout(() => startCollectionWatcher(collection, coin, io), 5000);
  });
}
