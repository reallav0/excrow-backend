import express from "express";
import { findByEmail, findByUserId } from "../models/User.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { validateEscrowInput, validateDisputeInput, validatePagination, sanitizeString } from "../utils/validator.js";
import { allocateDepositAddress as allocateBtcAddress } from "../services/wallet/btc.service.js";
import { allocateDepositAddress as allocateLtcAddress } from "../services/wallet/ltc.service.js";
import {
  createEscrow,
  findByEscrowId,
  findByInternalId,
  findByBuyerId,
  findBySellerId,
  findByStatus,
  updateStatus,
  recordDeposit,
  updateConfirmations,
  markInProgress,
  markDelivered,
  completeEscrow,
  cancelEscrow,
  refundEscrow,
  expireEscrow,
  openDispute,
  addDisputeEvidence,
  resolveDispute,
  hasOpenDispute,
  findDisputedEscrows,
  verifyCaptcha,
  confirmAntiFraud,
  flagEscrow,
  updateRiskScore,
  deleteEscrow,
  getUserEscrowStats,
} from "../models/Escrow.js";

const router = express.Router();

// All escrow routes require authentication
router.use(authenticate);

/* ===================== CREATE ESCROW ===================== */
router.post("/create", async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get buyer (current user)
    const buyer = await findByUserId(userId);
    if (!buyer) {
      return res.status(404).json({ message: "Buyer user not found" });
    }

    // Extract request data
    const {
      seller_email,
      amount_btc,
      amount_ltc,
      item_description,
      item_type,
      protection_terms,
      auto_release,
      anti_fraud_confirmed,
      coin,
      currency,
    } = req.body;

    // Determine currency: accept "coin" or "currency", default "ltc"
    const rawCurrency = (coin || currency || "ltc").toLowerCase();
    if (!["btc", "ltc"].includes(rawCurrency)) {
      return res.status(400).json({ message: "Invalid currency. Supported: btc, ltc" });
    }

    // Pick the correct amount based on currency
    const amount = rawCurrency === "btc" ? amount_btc : (amount_ltc || amount_btc);

    // Validate input
    const inputCheck = validateEscrowInput({ amount, item_description, item_type, seller_email });
    if (!inputCheck.valid) {
      return res.status(400).json({ message: inputCheck.errors[0], errors: inputCheck.errors });
    }

    // Find seller by email
    const seller = await findByEmail(seller_email);
    if (!seller) {
      return res.status(404).json({ message: "Seller email not found" });
    }

    if (seller.userId === userId) {
      return res.status(400).json({ message: "Cannot create escrow with yourself" });
    }

    // Parse auto_release to a number of hours (handles "24h" or 24)
    let autoReleaseHours = 24;
    if (auto_release) {
      autoReleaseHours = parseInt(String(auto_release).replace(/\D/g, ""), 10) || 24;
    }

    // Allocate deposit address based on currency
    let depositAddress;
    try {
      const addressResult = rawCurrency === "btc"
        ? await allocateBtcAddress({ id: `escrow_${Date.now()}` })
        : await allocateLtcAddress({ id: `escrow_${Date.now()}` });
      depositAddress = addressResult.address;
    } catch (error) {
      console.error("Address allocation error:", error);
      return res.status(500).json({ message: "Failed to allocate deposit address", error: error.message });
    }

    const escrow = await createEscrow({
      buyerId: userId,
      buyerEmail: buyer.email,
      sellerId: seller.userId,
      sellerEmail: seller_email,
      itemDescription: sanitizeString(item_description),
      itemType: item_type,
      protection: protection_terms || "Standard protection",
      autoReleaseHours,
      amount,
      depositAddress,
      currency: rawCurrency,
    });

    if (!anti_fraud_confirmed) {
      await flagEscrow(escrow.escrowId, "Anti-fraud not confirmed by buyer");
    }

    // Return escrow details
    res.status(201).json({
      message: "Escrow created successfully",
      escrowId: escrow.escrowId,
      depositAddress,
      currency: rawCurrency.toUpperCase(),
      amountRequired: amount,
      status: escrow.status,
      expiresAt: escrow.expiresAt,
    });
  } catch (error) {
    console.error("Create Escrow Error:", error);
    res.status(500).json({ message: "Error creating escrow", error: error.message });
  }
});
/* ===================== GET ALL ESCROWS FOR USER ===================== */
router.get("/", async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get escrows where user is buyer
    const buyerEscrows = await findByBuyerId(userId);
    // Get escrows where user is seller
    const sellerEscrows = await findBySellerId(userId);

    // Combine and deduplicate
    const allEscrows = [...(buyerEscrows || []), ...(sellerEscrows || [])];

    // Format response
    const escrows = allEscrows.map((escrow) => ({
      id: escrow._id || escrow.escrowId,
      escrowId: escrow.escrowId,
      buyer_email: escrow.buyer?.email || escrow.buyerEmail,
      seller_email: escrow.seller?.email || escrow.sellerEmail,
      amount: escrow.financials?.amount || escrow.financials?.amountBTC || 0,
      coin: (escrow.financials?.currency || "BTC").toUpperCase(),
      status: escrow.status,
      item_description: escrow.item?.description || escrow.itemDescription,
      item_type: escrow.item?.type || escrow.itemType,
      created_at: escrow.createdAt,
      updated_at: escrow.updatedAt,
      expires_at: escrow.expiresAt,
      completed_at: escrow.completedAt || null,
      cancelled_at: escrow.cancelledAt || null,
      deposit_address: escrow.financials?.depositAddress || escrow.depositAddress,
      tx_id: escrow.financials?.txId || escrow.txId || null,
      confirmations: escrow.financials?.confirmations || 0,
      auto_release_at: escrow.terms?.autoReleaseAt || escrow.autoReleaseAt,
      protection_level: escrow.terms?.protection || escrow.protection || "standard",
      anti_fraud_confirmed: escrow.security?.antiFraudConfirmed || escrow.antiFraudConfirmed || false,
    }));

    res.status(200).json({ escrows });
  } catch (error) {
    console.error("Get Escrows Error:", error);
    res.status(500).json({ message: "Error retrieving escrows", error: error.message });
  }
});

/* ===================== GET ESCROW DETAIL ===================== */
router.post("/detail/:id", async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get escrow ID from URL params
    const escrowId = req.params.id;
    if (!escrowId) {
      return res.status(400).json({ message: "Escrow ID is required" });
    }

    // Find escrow
    const escrow = await findByEscrowId(escrowId);
    if (!escrow) {
      return res.status(404).json({ message: "Escrow not found" });
    }

    // Check authorization - user must be buyer or seller
    const buyerId = escrow.buyer?.userId || escrow.buyerId;
    const sellerId = escrow.seller?.userId || escrow.sellerId;

    if (userId !== buyerId && userId !== sellerId) {
      return res.status(403).json({ message: "You don't have access to this escrow" });
    }

    // Get buyer and seller details
    const buyer = await findByUserId(buyerId);
    const seller = await findByUserId(sellerId);

    // Format response according to spec
    const data = {
      escrowId: escrow.escrowId,
      buyer: {
        userId: buyerId,
        username: buyer?.username || "User",
        email: buyer?.email || escrow.buyerEmail || null,
      },
      seller: {
        userId: sellerId,
        email: seller?.email || escrow.sellerEmail || null,
        username: seller?.username || "User",
      },
      item: {
        description: escrow.item?.description || escrow.itemDescription,
        type: escrow.item?.type || escrow.itemType,
      },
      terms: {
        protection: escrow.terms?.protection || escrow.protection || "standard",
        autoReleaseHours: escrow.terms?.autoReleaseHours || escrow.autoReleaseHours || 24,
        autoReleaseAt: escrow.terms?.autoReleaseAt || escrow.autoReleaseAt,
      },
      financials: {
        currency: (escrow.financials?.currency || "BTC").toUpperCase(),
        amount: escrow.financials?.amount || escrow.financials?.amountBTC || 0,
        depositAddress: escrow.financials?.depositAddress || escrow.depositAddress,
        txId: escrow.financials?.txId || escrow.txId || null,
        confirmations: escrow.financials?.confirmations || 0,
      },
      status: escrow.status,
      dispute: {
        opened: escrow.dispute?.opened || false,
        openedBy: escrow.dispute?.openedBy || null,
        reason: escrow.dispute?.reason || null,
        evidence: escrow.dispute?.evidence || null,
        resolved: escrow.dispute?.resolved || false,
        resolution: escrow.dispute?.resolution || null,
        resolvedBy: escrow.dispute?.resolvedBy || null,
        resolvedAt: escrow.dispute?.resolvedAt || null,
      },
      security: {
        captchaVerified: escrow.security?.captchaVerified || false,
        antiFraudConfirmed: escrow.security?.antiFraudConfirmed || false,
        flagged: escrow.security?.flagged || false,
        flaggedReason: escrow.security?.flaggedReason || null,
      },
      expiresAt: escrow.expiresAt,
      completedAt: escrow.completedAt || null,
      cancelledAt: escrow.cancelledAt || null,
      createdAt: escrow.createdAt,
      updatedAt: escrow.updatedAt,
    };

    res.status(200).json(data);
  } catch (error) {
    console.error("Get Escrow Detail Error:", error);
    res.status(500).json({ message: "Error retrieving escrow details", error: error.message });
  }
});

/* ===================== DISPUTE ROUTES ===================== */

/* ===================== GET /api/escrow/disputes ===================== */
router.get("/disputes", async (req, res) => {
  try {
    const userId = req.user.userId;

    // Collect all escrow IDs where user is buyer or seller
    const buyerEscrows = await findByBuyerId(userId);
    const sellerEscrows = await findBySellerId(userId);
    const allEscrows = [...(buyerEscrows || []), ...(sellerEscrows || [])];

    const escrowIds = allEscrows.map((e) => e.escrowId);
    if (escrowIds.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch disputed escrows with optional filters and capped pagination
    const { status } = req.query;
    const { limit, offset } = validatePagination(req.query);
    const disputedEscrows = await findDisputedEscrows(escrowIds, { status, limit, offset });

    // Resolve usernames for buyer / seller
    const userCache = {};
    const resolveUsername = async (uid) => {
      if (!uid) return null;
      if (userCache[uid]) return userCache[uid];
      const user = await findByUserId(uid);
      const username = user?.username || null;
      userCache[uid] = username;
      return username;
    };

    const result = [];
    for (const escrow of disputedEscrows) {
      const d = escrow.dispute;
      const buyerUid = escrow.buyer?.userId || null;
      const sellerUid = escrow.seller?.userId || null;

      result.push({
        escrowId: escrow.escrowId,
        reason: d.reason,
        evidence: d.evidence,
        openedBy: d.openedBy,
        openedAt: d.openedAt,
        resolved: d.resolved,
        resolution: d.resolution,
        resolvedBy: d.resolvedBy,
        resolvedAt: d.resolvedAt,
        escrowAmount: escrow.financials?.amount || escrow.financials?.amountBTC || 0,
        escrowCoin: (escrow.financials?.currency || "btc").toUpperCase(),
        buyerUsername: await resolveUsername(buyerUid),
        sellerUsername: await resolveUsername(sellerUid),
        status: d.status,
        severity: d.severity,
      });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("Get Disputes Error:", error);
    res.status(500).json({ message: "Error retrieving disputes", error: error.message });
  }
});

/* ===================== POST /api/escrow/disputes ===================== */
router.post("/disputes", async (req, res) => {
  try {
    const userId = req.user.userId;
    const { escrowId, reason, evidence } = req.body;

    // Validate dispute input
    const disputeCheck = validateDisputeInput({ escrowId, reason, evidence });
    if (!disputeCheck.valid) {
      return res.status(400).json({ message: disputeCheck.errors[0], errors: disputeCheck.errors });
    }

    // Find the escrow
    const escrow = await findByEscrowId(escrowId);
    if (!escrow) {
      return res.status(404).json({ message: "Escrow not found" });
    }

    // Ensure the user is a party to the escrow
    const buyerId = escrow.buyer?.userId || escrow.buyerId;
    const sellerId = escrow.seller?.userId || escrow.sellerId;
    if (userId !== buyerId && userId !== sellerId) {
      return res.status(403).json({ message: "You are not a party to this escrow" });
    }

    // Check for existing open dispute
    const existingDispute = await hasOpenDispute(escrowId);
    if (existingDispute) {
      return res.status(409).json({ message: "A dispute already exists for this escrow" });
    }

    // Open dispute on the escrow document
    const role = userId === buyerId ? "buyer" : "seller";
    await openDispute(escrowId, {
      openedBy: role,
      reason,
      evidence,
    });

    // Re-fetch to get the updated dispute data
    const updated = await findByEscrowId(escrowId);
    const d = updated.dispute;

    res.status(201).json({
      escrowId: updated.escrowId,
      reason: d.reason,
      evidence: d.evidence,
      openedBy: d.openedBy,
      openedAt: d.openedAt,
      resolved: d.resolved,
      resolution: d.resolution,
      resolvedBy: d.resolvedBy,
      resolvedAt: d.resolvedAt,
      status: d.status,
      severity: d.severity,
      message: "Dispute created successfully",
    });
  } catch (error) {
    console.error("Create Dispute Error:", error);
    res.status(500).json({ message: "Error creating dispute", error: error.message });
  }
});

export default router;