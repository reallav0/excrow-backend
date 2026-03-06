import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import { createLocalUser, findByEmail, findByUsername, findByUserId } from "../models/User.js";
import { createSession, invalidateAllUserSessions, findBySessionId } from "../models/SessionStore.js";
import { fetchDataByUserId } from "../models/Data.js";
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
  verifyCaptcha,
  confirmAntiFraud,
  flagEscrow,
  updateRiskScore,
  deleteEscrow,
  getUserEscrowStats,
} from "../models/Escrow.js";
import { Query } from "mongoose";

const router = express.Router();

/* ===================== CREATE ESCROW ===================== */
router.post("/create", async (req, res) => {
  try {
    // Verify JWT token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ logout: true, message: "No token provided" });
    }

    const token = authHeader.substring(7);

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ logout: true, message: "Invalid token" });
    }

    const { sessionId, userId } = decoded;

    // Verify session
    const session = await findBySessionId(sessionId);
    if (!session || !session.valid || session.expiresAt < new Date()) {
      return res.status(401).json({ logout: true, message: "Session expired" });
    }

    // Get buyer (current user)
    const buyer = await findByUserId(userId);
    if (!buyer) {
      return res.status(404).json({ message: "Buyer user not found" });
    }

    // Extract request data
    const {
      seller_email,
      amount_btc,
      item_description,
      item_type,
      protection_terms,
      auto_release,
      anti_fraud_confirmed,
      currency = "ltc"
    } = req.body;

    // Validation
    if (!seller_email || !amount_btc || !item_description || !item_type) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    if (!["digital", "physical"].includes(item_type)) {
      return res.status(400).json({ message: "Invalid item type" });
    }

    if (amount_btc <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    // Find seller by email
    const seller = await findByEmail(seller_email);
    if (!seller) {
      return res.status(404).json({ message: "Seller email not found" });
    }

    if (seller.userId === userId) {
      return res.status(400).json({ message: "Cannot create escrow with yourself" });
    }

    // Validate currency
    if (!["btc", "ltc"].includes(currency.toLowerCase())) {
      return res.status(400).json({ message: "Invalid currency. Supported: btc, ltc" });
    }

    const currencyLower = currency.toLowerCase();
    const feeBTC = amount_btc * 0.01; // 1% fee
    const escrowId = `escrow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Allocate deposit address based on currency
    let depositAddress;
    try {
      const addressResult = currencyLower === "btc"
        ? await allocateBtcAddress({ id: escrowId })
        : await allocateLtcAddress({ id: escrowId });
      depositAddress = addressResult.address;
    } catch (error) {
      console.error("Address allocation error:", error);
      return res.status(500).json({ message: "Failed to allocate deposit address", error: error.message });
    }

    const escrow = await createEscrow({
      escrowId,
      buyerId: userId,
      buyerIp: req.ip,
      buyerUserAgent: req.headers["user-agent"],
      buyerEmail: buyer.email,
      sellerId: seller.userId,
      sellerEmail: seller_email,
      itemDescription: item_description,
      itemType: item_type,
      protection: protection_terms || "Standard protection",
      autoReleaseHours: auto_release || 24,
      amountBTC: amount_btc,
      feeBTC,
      depositAddress,
      currency: currencyLower
    });

    if (!anti_fraud_confirmed) {
      await flagEscrow(escrow.escrowId, "Anti-fraud not confirmed by buyer");
    }

    // Return escrow details
    res.status(201).json({
      message: "Escrow created successfully",
      escrowId: escrow.escrowId,
      depositAddress,
      currency: currencyLower,
      amountRequired: amount_btc,
      fee: feeBTC,
      totalAmount: amount_btc + feeBTC,
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
    // Verify JWT token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ logout: true, message: "No token provided" });
    }

    const token = authHeader.substring(7);

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ logout: true, message: "Invalid token" });
    }

    const { sessionId, userId } = decoded;

    // Verify session
    const session = await findBySessionId(sessionId);
    if (!session || !session.valid || session.expiresAt < new Date()) {
      return res.status(401).json({ logout: true, message: "Session expired" });
    }

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
      amount_btc: escrow.financials?.amountBTC || escrow.amountBTC,
      amount_ltc: escrow.financials?.amountLTC || escrow.amountLTC || null,
      coin: escrow.financials?.currency?.toUpperCase() || "BTC",
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
      buyer_name: escrow.buyer?.username || "User",
      seller_name: escrow.seller?.username || "User",
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
    // Verify JWT token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ logout: true, message: "No token provided" });
    }

    const token = authHeader.substring(7);

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ logout: true, message: "Invalid token" });
    }

    const { sessionId, userId } = decoded;

    // Verify session
    const session = await findBySessionId(sessionId);
    if (!session || !session.valid || session.expiresAt < new Date()) {
      return res.status(401).json({ logout: true, message: "Session expired" });
    }

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
        ip: escrow.buyerIp || null,
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
        currency: escrow.financials?.currency || escrow.currency || "btc",
        amountBTC: escrow.financials?.amountBTC || escrow.amountBTC,
        feeBTC: escrow.financials?.feeBTC || escrow.feeBTC,
        totalBTC: (escrow.financials?.amountBTC || escrow.amountBTC) + (escrow.financials?.feeBTC || escrow.feeBTC),
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

export default router;