import express from "express";
import { findByUserId } from "../models/User.js";
import { fetchDataByUserId } from "../models/Data.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();

/* ------------------ GET USER (authenticated) ------------------ */
router.get("/user", authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get user data
    const user = await findByUserId(userId);
    if (!user) {
      return res.status(404).json({ logout: true, message: "User not found" });
    }
    const data = await fetchDataByUserId(userId);
    if (!data) {
      return res.status(404).json({ logout: true, message: "Data not found" });
    }

    // Return user data (exclude sensitive info like passwordHash)
    res.json({
      userId: user.userId,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar,
      birthdate: user.birthdate,
      bio: user.bio,
      totalEscrows: data.totalEscrows,
      openingEscrows: data.openingEscrows,
      completedEscrows: data.completedEscrows,
      disputedEscrows: data.disputedEscrows,
      cancelledEscrows: data.cancelledEscrows,
      buyerStats: data.buyerStats,
      sellerStats: data.sellerStats,
    });
  } catch (error) {
    console.error("Get User Error:", error);
    res.status(500).json({ message: "Error retrieving user data" });
  }
});

/* ------------------ GET PUBLIC PROFILE ------------------ */
router.get("/profile/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const userId = parseInt(id);

    // Get user data
    const user = await findByUserId(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const data = await fetchDataByUserId(userId);

    res.json({
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      bio: user.bio,
      completedEscrows: data?.completedEscrows || 0,
      buyerStats: data?.buyerStats || null,
      sellerStats: data?.sellerStats || null,
      reputationScore: data?.reputationScore || 0,
    });
  } catch (error) {
    console.error("Get Profile Error:", error);
    res.status(500).json({ message: "Error retrieving profile data" });
  }
});

export default router;
