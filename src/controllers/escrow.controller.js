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
router.post("/detail/:id", async (req, res) => {
  const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ logout: true, message: "No token provided" });
    }

    const token = authHeader.substring(7);
    console.log('Run?')
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

    const id = req.params.id
    if (!req.params.id){
      return res.status(401).json({ logout: true, message: "No id provided" });
    }
    const detail = await findByEscrowId(id)
   

    const user = await findByUserId(userId);
    if (!user) {
      return res.status(404).json({ message: "Buyer user not found" });
    }
    
    const data = {
        escrowId: detail.escrowId,
        buyer: {
          userId: detail.buyer.userId,
        },
        seller: {
          userId: detail.seller.userId,
          email: detail.seller.email
        },
        item: {
          description: detail.item.description,
          type: detail.item.type
        },

        terms: {
          protection: detail.terms.protection,
          autoReleaseHours: detail.terms.autoReleaseHours,
          autoReleaseAt: detail.terms.autoReleaseAt
        },

        financials: {
          currency: detail.financials.currency,
          amountBTC: detail.financials.amountBTC,
          feeBTC: detail.financials.feeBTC,
          totalBTC: detail.financials.totalBTC,
          depositAddress: detail.financials.depositAddress,
          txId: detail.financials.txId,
          confirmations: detail.financials.confirmations
        },

        status: detail.status,

        dispute: {
          opened: detail.dispute.opened,
          openedBy: detail.dispute.openedBy,
          reason: detail.dispute.reason,
          evidence: detail.dispute.evidence,
          resolved: detail.dispute.resolved,
          resolution: detail.dispute.resolution,
          resolvedBy: detail.dispute.resolvedBy,
          resolvedAt: detail.dispute.resolvedAt
        },

        security: {
          captchaVerified: detail.security.captchaVerified,
          antiFraudConfirmed: detail.security.antiFraudConfirmed,
          flagged: detail.security.flagged,
          flaggedReason: detail.security.flaggedReason
        },

        expiresAt: detail.expiresAt,
        completedAt: detail.completedAt,
        cancelledAt: detail.cancelledAt,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt
      };

      if (userId == detail.buyer.userId || userId == detail.seller.userId){
        res.status(200).json(data)
    }
})
export default router;