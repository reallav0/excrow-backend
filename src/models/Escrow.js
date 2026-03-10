import { getDB } from "../config/db.js";
import { ObjectId } from "mongodb";
import crypto from "crypto";

const COLLECTION = "escrows";

/**
 * Generate a unique public escrow ID based on multiple entropy sources
 * Combines: amount, both emails, timestamp for maximum randomness
 */
function generateEscrowId(amount, buyerEmail, sellerEmail) {
  // Create a hash input combining all entropy sources
  const timestamp = Date.now().toString();
  const randomBytes = crypto.randomBytes(8).toString('hex');
  
  const hashInput = `${amount}|${buyerEmail}|${sellerEmail}|${timestamp}|${randomBytes}`;
  
  // Generate SHA256 hash
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex');
  
  // Extract 6 characters for the ID (base36 format for readability)
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "ESC-";
  
  for (let i = 0; i < 6; i++) {
    const charCode = parseInt(hash.substring(i * 2, i * 2 + 2), 16);
    result += chars[charCode % chars.length];
  }
  
  return result;
}

/**
 * Create a new escrow
 */
export async function createEscrow({
  buyerId,
  buyerEmail,
  sellerId,
  sellerEmail,
  itemDescription,
  itemType,
  protection,
  autoReleaseHours,
  amount,
  currency,
  depositAddress,
}) {
  const db = getDB();

  const autoReleaseAt = new Date(Date.now() + autoReleaseHours * 60 * 60 * 1000);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const curr = (currency || "btc").toUpperCase(); // "BTC" | "LTC"

  const escrow = {
    // Identity
    escrowId: generateEscrowId(amount, buyerEmail, sellerEmail),
    internalId: new ObjectId(),

    // Parties
    buyer: {
      userId: buyerId,
      email: buyerEmail,
    },

    seller: {
      userId: sellerId,
      email: sellerEmail,
    },

    // Item / Service
    item: {
      description: itemDescription,
      type: itemType, // "digital" | "physical"
    },

    // Buyer Protection & Rules
    terms: {
      protection,
      autoReleaseHours,
      autoReleaseAt,
    },

    // Financials
    financials: {
      currency: curr,
      amount,
      depositAddress,
      txId: null,
      confirmations: 0,
    },

    // Status
    status: "waiting_deposit",

    // Dispute System
    dispute: {
      opened: false,
      openedBy: null,
      reason: null,
      evidence: [],
      resolved: false,
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
    },

    // Security
    security: {
      captchaVerified: false,
      antiFraudConfirmed: false,
      riskScore: 0,
      flagged: false,
      flaggedReason: null,
    },

    // Lifecycle
    expiresAt,
    completedAt: null,
    cancelledAt: null,

    // Audit
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Ensure indexes
  await db.collection(COLLECTION).createIndex({ escrowId: 1 }, { unique: true });
  await db.collection(COLLECTION).createIndex({ "buyer.userId": 1 });
  await db.collection(COLLECTION).createIndex({ "seller.userId": 1 });
  await db.collection(COLLECTION).createIndex({ status: 1 });

  const result = await db.collection(COLLECTION).insertOne(escrow);
  return { ...escrow, _id: result.insertedId };
}

/**
 * Find escrow by public ID (escrowId)
 */
export async function findByEscrowId(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ escrowId });
}

/**
 * Find escrow by internal MongoDB ID
 */
export async function findByInternalId(internalId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({ internalId: new ObjectId(internalId) });
}

/**
 * Find all escrows for a buyer
 */
export async function findByBuyerId(buyerId) {
  const db = getDB();
  return db.collection(COLLECTION).find({ "buyer.userId": buyerId }).toArray();
}

/**
 * Find all escrows for a seller
 */
export async function findBySellerId(sellerId) {
  const db = getDB();
  return db.collection(COLLECTION).find({ "seller.userId": sellerId }).toArray();
}

/**
 * Find escrows by status
 */
export async function findByStatus(status) {
  const db = getDB();
  return db.collection(COLLECTION).find({ status }).toArray();
}

/**
 * Update escrow status
 */
export async function updateStatus(escrowId, newStatus) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: newStatus,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Record deposit detection
 */
export async function recordDeposit(escrowId, { txId, confirmations }) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        "financials.txId": txId,
        "financials.confirmations": confirmations,
        status: "deposit_detected",
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Update confirmations
 */
export async function updateConfirmations(escrowId, confirmations) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        "financials.confirmations": confirmations,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Mark as in progress
 */
export async function markInProgress(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "in_progress",
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Mark as delivered (buyer marks delivery)
 */
export async function markDelivered(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "delivered",
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Complete escrow (release funds to seller)
 */
export async function completeEscrow(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Cancel escrow (refund to buyer)
 */
export async function cancelEscrow(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Refund escrow (return funds)
 */
export async function refundEscrow(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "refunded",
        cancelledAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Mark as expired
 */
export async function expireEscrow(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "expired",
        cancelledAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Compute severity based on dispute reason
 */
function computeSeverity(reason) {
  const highSeverity = [
    "Item not received",
    "Fraud or scam",
    "Item damaged or different",
  ];
  const mediumSeverity = ["Poor quality", "Communication issue"];

  if (highSeverity.includes(reason)) return "high";
  if (mediumSeverity.includes(reason)) return "medium";
  return "low";
}

/**
 * Open a dispute
 */
export async function openDispute(escrowId, { openedBy, reason, evidence }) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: "disputed",
        "dispute.opened": true,
        "dispute.openedBy": openedBy, // "buyer" | "seller"
        "dispute.reason": reason,
        "dispute.evidence": evidence || [],
        "dispute.openedAt": new Date(),
        "dispute.severity": computeSeverity(reason),
        "dispute.status": "open",
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Check if an escrow already has an open (unresolved) dispute
 */
export async function hasOpenDispute(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).findOne({
    escrowId,
    "dispute.opened": true,
    "dispute.resolved": false,
  });
}

/**
 * Find all disputed escrows for a set of escrowIds with optional filters
 */
export async function findDisputedEscrows(escrowIds, { status, limit, offset } = {}) {
  const db = getDB();

  const query = {
    escrowId: { $in: escrowIds },
    "dispute.opened": true,
  };
  if (status === "open") query["dispute.resolved"] = false;
  else if (status === "resolved") query["dispute.resolved"] = true;

  let cursor = db
    .collection(COLLECTION)
    .find(query)
    .sort({ "dispute.openedAt": -1 });

  if (offset) cursor = cursor.skip(Number(offset));
  if (limit) cursor = cursor.limit(Number(limit));

  return cursor.toArray();
}

/**
 * Add evidence to a dispute
 */
export async function addDisputeEvidence(escrowId, { by, type, content }) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $push: {
        "dispute.evidence": {
          by, // "buyer" | "seller"
          type, // "text" | "file"
          content,
          createdAt: new Date(),
        },
      },
      $set: {
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Resolve dispute
 */
export async function resolveDispute(escrowId, { resolution, resolvedBy }) {
  const db = getDB();
  
  let newStatus = resolution === "release" ? "completed" : "refunded";

  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        status: newStatus,
        "dispute.resolved": true,
        "dispute.resolution": resolution, // "release" | "refund"
        "dispute.resolvedBy": resolvedBy, // "admin" | "system"
        "dispute.resolvedAt": new Date(),
        "dispute.status": "resolved",
        completedAt: resolution === "release" ? new Date() : null,
        cancelledAt: resolution === "refund" ? new Date() : null,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Verify captcha for escrow
 */
export async function verifyCaptcha(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        "security.captchaVerified": true,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Confirm anti-fraud check
 */
export async function confirmAntiFraud(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        "security.antiFraudConfirmed": true,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Flag escrow as suspicious
 */
export async function flagEscrow(escrowId, reason) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        "security.flagged": true,
        "security.flaggedReason": reason,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Update risk score
 */
export async function updateRiskScore(escrowId, riskScore) {
  const db = getDB();
  return db.collection(COLLECTION).updateOne(
    { escrowId },
    {
      $set: {
        "security.riskScore": riskScore,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Delete escrow (use sparingly)
 */
export async function deleteEscrow(escrowId) {
  const db = getDB();
  return db.collection(COLLECTION).deleteOne({ escrowId });
}

/**
 * Get escrow statistics for a user
 */
export async function getUserEscrowStats(userId, role = "buyer") {
  const db = getDB();
  
  const userField = role === "buyer" ? "buyer.userId" : "seller.userId";
  
  const stats = await db.collection(COLLECTION).aggregate([
    { $match: { [userField]: userId } },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  return stats;
}