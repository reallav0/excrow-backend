import { getDB } from "../config/db.js";

const COLLECTION = "transactions";

/**
 * Create new transaction (escrow)
 */
export async function createTransaction({
  buyerId,
  sellerId,
  amount,
  currency = "USDT",
  description = "",
  escrowWalletAddress,
}) {
  const db = getDB();

  // Auto-increment transactionId
  const lastTx = await db
    .collection(COLLECTION)
    .find()
    .sort({ transactionId: -1 })
    .limit(1)
    .toArray();

  const newTransactionId =
    lastTx.length === 0 ? 0 : lastTx[0].transactionId + 1;

  const tx = {
    transactionId: newTransactionId,
    buyerId,
    sellerId,
    amount,
    currency,
    description,
    escrowWalletAddress: escrowWalletAddress || null,

    status: "pending", // pending → awaiting_deposit → holding → released/completed/cancelled

    buyerWalletAddress: null,
    sellerWalletAddress: null,
    releaseTxHash: null,
    cancelTxHash: null,

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.collection(COLLECTION).insertOne(tx);
  return tx;
}

/**
 * Get a transaction by ID
 */
export async function findByTransactionId(transactionId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ transactionId });
}

/**
 * Update transaction fields
 */
export async function updateTransaction(transactionId, updates) {
  const db = getDB();

  updates.updatedAt = new Date();

  return db.collection(COLLECTION).updateOne(
    { transactionId },
    { $set: updates }
  );
}

/**
 * Delete a transaction
 */
export async function deleteTransaction(transactionId) {
  const db = getDB();
  return db.collection(COLLECTION).deleteOne({ transactionId });
}

/**
 * List transactions for a user (buyer or seller)
 */
export async function listUserTransactions(userId) {
  const db = getDB();
  return db
    .collection(COLLECTION)
    .find({
      $or: [{ buyerId: userId }, { sellerId: userId }],
    })
    .sort({ createdAt: -1 })
    .toArray();
}