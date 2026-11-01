import express from "express";
import axios from "axios";
import { getDB } from "../config/db.js";
import {
  clearAdminSessionCookie,
  authenticateAdmin,
  createAdminSession,
  listAdminSessions,
  revokeAdminSession,
  revokeTokenSession,
  setAdminSessionCookie,
} from "../middleware/adminAuth.middleware.js";
import { publishAdminLiveFeed, getAdminLiveFeedItems } from "../services/adminLiveFeed.service.js";
import { getClientIp } from "../utils/clientIp.js";
import { RATE_LIMIT_ENABLED } from "../middleware/rateLimit.middleware.js";

const router = express.Router();

const ALLOWED_REVENUE_RANGES = new Set(["7d", "30d", "90d"]);
const ALLOWED_ESCROW_ACTIONS = new Set(["release", "refund", "pause", "cancel"]);
const ALLOWED_ESCROW_STATUSES = new Set(["funded", "pending", "dispute", "complete", "cancelled"]);
const ALLOWED_DISPUTE_STATUS = new Set(["open", "escalated", "resolved"]);
const ALLOWED_DISPUTE_SEVERITY = new Set(["high", "medium", "low"]);
const ALLOWED_WITHDRAWAL_STATUS = new Set(["pending", "broadcast", "confirmed", "rejected", ""]);
const ALLOWED_DECISIONS = new Set(["release", "refund", "split"]);
const ALLOWED_KYC = new Set(["verified", "pending", "unverified"]);

const adminLoginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function checkAdminLoginLockout(email) {
  // Benchmark / load-test mode: no lockouts (see RATE_LIMIT_ENABLED).
  if (!RATE_LIMIT_ENABLED) return { locked: false };

  const key = String(email || "").toLowerCase();
  const record = adminLoginAttempts.get(key);
  if (!record) return { locked: false };
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  if (record.firstAttempt + ATTEMPT_WINDOW_MS < Date.now()) {
    adminLoginAttempts.delete(key);
    return { locked: false };
  }
  return { locked: false };
}

function recordFailedAdminLogin(email) {
  if (!RATE_LIMIT_ENABLED) return;

  const key = String(email || "").toLowerCase();
  const record = adminLoginAttempts.get(key) || { count: 0, firstAttempt: Date.now() };
  record.count += 1;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  adminLoginAttempts.set(key, record);
}

function clearAdminLoginAttempts(email) {
  adminLoginAttempts.delete(String(email || "").toLowerCase());
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of adminLoginAttempts.entries()) {
    if (record.firstAttempt + ATTEMPT_WINDOW_MS < now && (!record.lockedUntil || record.lockedUntil < now)) {
      adminLoginAttempts.delete(key);
    }
  }
}, 30 * 60 * 1000);

async function verifyRecaptcha(captchaToken) {
  try {
    const response = await axios.post("https://www.google.com/recaptcha/api/siteverify", null, {
      params: {
        secret: process.env.RECAPTCHA_SECRET_KEY,
        response: captchaToken,
      },
    });
    return response.data.success;
  } catch {
    return false;
  }
}

function parsePagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function parseDateSafe(value) {
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function toIsoOrNull(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : parseDateSafe(v);
  return d ? d.toISOString() : null;
}

function mapEscrowStatus(raw, disputeOpened = false) {
  const status = String(raw || "").toLowerCase();
  if (disputeOpened || ["dispute", "disputed"].includes(status)) return "dispute";
  if (["completed", "released", "complete"].includes(status)) return "complete";
  if (["cancelled", "refunded", "expired"].includes(status)) return "cancelled";
  if (["in_progress", "deposit_detected", "funded", "delivered"].includes(status)) return "funded";
  return "pending";
}

function escrowListItem(doc) {
  const mappedStatus = mapEscrowStatus(doc.status, !!doc.dispute?.opened);
  return {
    id: doc.escrowId,
    buyerUsername: doc.buyerUsername || doc.buyer?.username || doc.buyer?.email || String(doc.buyer?.userId || ""),
    sellerUsername: doc.sellerUsername || doc.seller?.username || doc.seller?.email || String(doc.seller?.userId || ""),
    amount: Number(doc.financials?.amount || doc.amount || 0),
    coin: (doc.financials?.currency || doc.coin || "BTC").toString().toUpperCase(),
    status: mappedStatus,
    createdAt: doc.createdAt,
  };
}

function userListItem(doc, escrowsByUser) {
  const userEscrowCount = escrowsByUser.get(doc.userId) || 0;
  return {
    id: doc.userId,
    username: doc.username,
    kycStatus: doc.kycStatus || doc.kyc || "unverified",
    riskScore: Number(doc.riskScore ?? doc.risk ?? 0),
    escrowCount: userEscrowCount,
    banned: !!doc.banned,
    flagged: !!doc.flagged,
  };
}

function getEscrowDisputeSeverity(escrow) {
  const reason = (escrow.dispute?.reason || "").toLowerCase();
  if (escrow.dispute?.severity) return escrow.dispute.severity;
  if (reason.includes("fraud") || reason.includes("scam") || reason.includes("not received")) return "high";
  if (reason.includes("damaged") || reason.includes("different") || reason.includes("quality")) return "medium";
  return "low";
}

function asCsv(rows, headers) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
      return `\"${text.replace(/\"/g, '\"\"')}\"`;
    }
    return text;
  };

  const head = headers.join(",");
  const body = rows.map((row) => headers.map((h) => escape(row[h])).join(",")).join("\n");
  return `${head}\n${body}`;
}

async function auditLog(req, action, target, meta = {}) {
  const db = getDB();
  const clientIp = getClientIp(req);
  const log = {
    ts: new Date(),
    admin: req.admin?.id || "unknown",
    adminId: req.admin?.id || "unknown",
    action,
    actionType: action,
    target,
    targetEntity: target,
    ip: clientIp,
    ipAddress: clientIp,
    meta,
  };

  await db.collection("admin_audit_logs").insertOne(log);
  publishAdminLiveFeed({ type: "admin", text: `${req.admin?.username || "admin"} ${action} ${target}` });
}

async function getSingletonConfig(db, key, fallback) {
  const found = await db.collection("admin_config").findOne({ key });
  if (!found) {
    await db.collection("admin_config").insertOne({ key, value: fallback, updatedAt: new Date() });
    return fallback;
  }
  return found.value || fallback;
}

async function setSingletonConfig(db, key, value) {
  await db.collection("admin_config").updateOne(
    { key },
    { $set: { key, value, updatedAt: new Date() } },
    { upsert: true }
  );
}

router.post("/auth/login", async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const isCaptchaValid = await verifyRecaptcha(captchaToken);
    if (!isCaptchaValid) {
      return res.status(400).json({ message: "reCAPTCHA verification failed" });
    }

    const lockout = checkAdminLoginLockout(email);
    if (lockout.locked) {
      return res.status(429).json({
        message: "Too many failed login attempts. Please try again later.",
        retryAfter: lockout.retryAfter,
      });
    }

    const session = await createAdminSession({ email, password, ip: getClientIp(req) });
    if (!session) {
      recordFailedAdminLogin(email);
      return res.status(401).json({ message: "Invalid email or password" });
    }

    clearAdminLoginAttempts(email);
    setAdminSessionCookie(res, session.token);

    publishAdminLiveFeed({ type: "auth", text: `Admin login: ${session.admin.username}` });

    return res.status(200).json({
      message: "Login successful",
      admin: session.admin,
    });
  } catch (error) {
    return res.status(500).json({ message: "Admin login failed" });
  }
});

router.use(authenticateAdmin);

router.post("/auth/logout", async (req, res) => {
  revokeTokenSession(req.adminToken);
  clearAdminSessionCookie(res);
  await auditLog(req, "logout", "admin_session", {});
  res.status(200).json({ message: "Logged out" });
});

router.get("/auth/sessions", (req, res) => {
  const sessions = listAdminSessions();
  res.status(200).json({ items: sessions, total: sessions.length });
});

router.delete("/auth/sessions/:id", async (req, res) => {
  const ok = revokeAdminSession(req.params.id);
  if (!ok) return res.status(404).json({ message: "Session not found" });
  await auditLog(req, "revoke_session", `session:${req.params.id}`);
  res.status(200).json({ message: "Session revoked" });
});

router.get("/dashboard/metrics", async (req, res) => {
  try {
    const db = getDB();
    const escrows = await db.collection("escrows").find({}).toArray();
    const withdrawals = await db.collection("withdrawals").find({}).toArray();
    const usersCount = await db.collection("users").countDocuments({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const riskAlerts = await db.collection("risk_events").countDocuments({ status: { $ne: "dismissed" } });

    const startMonth = new Date();
    startMonth.setDate(1);
    startMonth.setHours(0, 0, 0, 0);

    let completedMonth = 0;
    let btcVolumeMonth = 0;
    let ltcVolumeMonth = 0;
    let platformRevenue = 0;
    let lockedFunds = 0;
    let openDisputes = 0;
    let activeEscrows = 0;
    let fundedEscrows = 0;
    let inDispute = 0;
    let pendingFundsBtc = 0;
    let pendingFundsLtc = 0;

    for (const escrow of escrows) {
      const amount = Number(escrow.financials?.amount || 0);
      const coin = String(escrow.financials?.currency || "BTC").toUpperCase();
      const status = mapEscrowStatus(escrow.status, !!escrow.dispute?.opened);
      const createdAt = parseDateSafe(escrow.createdAt);

      if (["pending", "funded", "dispute"].includes(status)) {
        activeEscrows += 1;
        lockedFunds += amount;
      }
      if (status === "pending") {
        if (coin === "BTC") pendingFundsBtc += amount;
        if (coin === "LTC") pendingFundsLtc += amount;
      }
      if (status === "funded") fundedEscrows += 1;
      if (status === "dispute") {
        inDispute += 1;
        openDisputes += 1;
      }

      if (status === "complete" && createdAt && createdAt >= startMonth) {
        completedMonth += 1;
        if (coin === "BTC") btcVolumeMonth += amount;
        if (coin === "LTC") ltcVolumeMonth += amount;
        platformRevenue += amount * 0.01;
      }
    }

    const pendingDeposits = escrows.filter((e) => mapEscrowStatus(e.status, !!e.dispute?.opened) === "pending").length;
    const pendingWithdrawals = withdrawals.filter((w) => (w.status || "pending") === "pending").length;

    return res.status(200).json({
      activeEscrows,
      fundedEscrows,
      inDispute,
      completedMonth,
      btcVolumeMonth,
      ltcVolumeMonth,
      platformRevenue,
      lockedFunds,
      riskAlerts,
      pendingDeposits,
      newUsersDay: usersCount,
      fraudBlocked: 0,
      openDisputes,
      adminUsername: req.admin.username,
      adminRole: req.admin.role,
      pendingWithdrawals,
      pendingFundsBtc,
      pendingFundsLtc,
    });
  } catch {
    return res.status(500).json({ message: "Failed to load dashboard metrics" });
  }
});

router.get("/dashboard/feed", (req, res) => {
  const items = getAdminLiveFeedItems(50);
  res.status(200).json({ items });
});

router.get("/dashboard/revenue-chart", async (req, res) => {
  const range = String(req.query.range || "30d");
  if (!ALLOWED_REVENUE_RANGES.has(range)) {
    return res.status(400).json({ message: "Invalid range. Allowed: 7d, 30d, 90d" });
  }

  const db = getDB();
  const escrows = await db.collection("escrows").find({}).toArray();

  const daysCount = Number(range.replace("d", ""));
  const dayMap = new Map();
  for (let i = daysCount - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toISOString().slice(5, 10);
    dayMap.set(label, { label, btc: 0, ltc: 0, btcPct: 0, ltcPct: 0 });
  }

  for (const escrow of escrows) {
    const createdAt = parseDateSafe(escrow.createdAt);
    if (!createdAt) continue;
    const label = createdAt.toISOString().slice(5, 10);
    const row = dayMap.get(label);
    if (!row) continue;
    const amount = Number(escrow.financials?.amount || 0);
    const coin = String(escrow.financials?.currency || "BTC").toUpperCase();
    if (coin === "BTC") row.btc += amount * 0.01;
    if (coin === "LTC") row.ltc += amount * 0.01;
  }

  const days = [...dayMap.values()].map((d) => {
    const total = d.btc + d.ltc;
    return {
      ...d,
      btcPct: total > 0 ? Math.round((d.btc / total) * 100) : 0,
      ltcPct: total > 0 ? Math.round((d.ltc / total) * 100) : 0,
    };
  });

  res.status(200).json({ days });
});

router.get("/dashboard/escrow-status-breakdown", async (req, res) => {
  const db = getDB();
  const escrows = await db.collection("escrows").find({}).toArray();
  const counts = { pending: 0, funded: 0, dispute: 0, complete: 0, cancelled: 0 };

  for (const escrow of escrows) {
    const status = mapEscrowStatus(escrow.status, !!escrow.dispute?.opened);
    counts[status] += 1;
  }

  const total = Math.max(1, escrows.length);
  const statuses = Object.entries(counts).map(([label, count]) => ({
    label,
    count,
    pct: Math.round((count / total) * 100),
  }));

  res.status(200).json({ statuses });
});

router.get("/escrows", async (req, res) => {
  const db = getDB();
  const { page, limit, skip } = parsePagination(req.query);
  const { status, coin, search } = req.query;

  if (status && !ALLOWED_ESCROW_STATUSES.has(String(status))) {
    return res.status(400).json({ message: "Invalid escrow status filter" });
  }

  const docs = await db.collection("escrows").find({}).sort({ createdAt: -1 }).toArray();
  let items = docs.map(escrowListItem);

  if (status) items = items.filter((x) => x.status === status);
  if (coin) items = items.filter((x) => x.coin === String(coin).toUpperCase());
  if (search) {
    const q = String(search).toLowerCase();
    items = items.filter((x) =>
      String(x.id).toLowerCase().includes(q) ||
      String(x.buyerUsername || "").toLowerCase().includes(q) ||
      String(x.sellerUsername || "").toLowerCase().includes(q)
    );
  }

  const total = items.length;
  const paged = items.slice(skip, skip + limit);
  res.status(200).json({ escrows: paged, total, page, limit });
});

router.get("/escrows/:id", async (req, res) => {
  const db = getDB();
  const escrow = await db.collection("escrows").findOne({ escrowId: req.params.id });
  if (!escrow) return res.status(404).json({ message: "Escrow not found" });

  const payload = {
    id: escrow.escrowId,
    status: mapEscrowStatus(escrow.status, !!escrow.dispute?.opened),
    buyerUsername: escrow.buyer?.username || escrow.buyer?.email || String(escrow.buyer?.userId || ""),
    sellerUsername: escrow.seller?.username || escrow.seller?.email || String(escrow.seller?.userId || ""),
    amount: Number(escrow.financials?.amount || 0),
    coin: String(escrow.financials?.currency || "BTC").toUpperCase(),
    depositAddress: escrow.financials?.depositAddress || null,
    txid: escrow.financials?.txId || null,
    autoReleaseAt: escrow.terms?.autoReleaseAt || null,
    createdAt: escrow.createdAt,
  };

  res.status(200).json(payload);
});

router.post("/escrows/:id/:action", async (req, res) => {
  const { id, action } = req.params;
  if (!ALLOWED_ESCROW_ACTIONS.has(action)) {
    return res.status(404).json({ message: "Unknown escrow action" });
  }

  const note = String(req.body?.note || "").trim();
  if (!note) return res.status(400).json({ message: "note is required" });

  const db = getDB();
  const statusMap = { release: "completed", refund: "refunded", pause: "paused", cancel: "cancelled" };
  const result = await db.collection("escrows").updateOne(
    { escrowId: id },
    {
      $set: { status: statusMap[action], updatedAt: new Date() },
      $push: {
        adminNotes: {
          note,
          action,
          adminId: req.admin.id,
          at: new Date(),
        },
      },
    }
  );

  if (!result.matchedCount) return res.status(404).json({ message: "Escrow not found" });

  await auditLog(req, `escrow_${action}`, `escrow:${id}`, { note });
  publishAdminLiveFeed({ type: "escrow", text: `Escrow ${id} ${action}d` });

  return res.status(200).json({ message: `Escrow ${action} successful` });
});

router.post("/escrows/:id/notes", async (req, res) => {
  const note = String(req.body?.note || "").trim();
  if (!note) return res.status(400).json({ message: "note is required" });

  const db = getDB();
  const result = await db.collection("escrows").updateOne(
    { escrowId: req.params.id },
    {
      $push: {
        adminNotes: {
          note,
          action: "note",
          adminId: req.admin.id,
          at: new Date(),
        },
      },
      $set: { updatedAt: new Date() },
    }
  );

  if (!result.matchedCount) return res.status(404).json({ message: "Escrow not found" });
  await auditLog(req, "escrow_note", `escrow:${req.params.id}`, { note });
  res.status(200).json({ message: "Note added" });
});

router.patch("/escrows/:id/status", async (req, res) => {
  const nextStatus = String(req.body?.status || "").trim();
  if (!nextStatus) return res.status(400).json({ message: "status is required" });

  const db = getDB();
  const result = await db.collection("escrows").updateOne(
    { escrowId: req.params.id },
    { $set: { status: nextStatus, updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Escrow not found" });

  await auditLog(req, "escrow_status_patch", `escrow:${req.params.id}`, { status: nextStatus });
  res.status(200).json({ message: "Escrow status updated" });
});

router.patch("/escrows/:id/timer", async (req, res) => {
  const autoReleaseAt = parseDateSafe(req.body?.autoReleaseAt);
  if (!autoReleaseAt) return res.status(400).json({ message: "autoReleaseAt must be a valid date" });

  const db = getDB();
  const result = await db.collection("escrows").updateOne(
    { escrowId: req.params.id },
    { $set: { "terms.autoReleaseAt": autoReleaseAt, updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Escrow not found" });

  await auditLog(req, "escrow_timer_patch", `escrow:${req.params.id}`, { autoReleaseAt: autoReleaseAt.toISOString() });
  res.status(200).json({ message: "Escrow timer updated" });
});

router.get("/users", async (req, res) => {
  const db = getDB();
  const { page, limit, skip } = parsePagination(req.query);

  if (req.query.kyc && !ALLOWED_KYC.has(String(req.query.kyc))) {
    return res.status(400).json({ message: "Invalid kyc filter" });
  }

  const users = await db.collection("users").find({}).toArray();
  const escrows = await db.collection("escrows").find({}).toArray();

  const escrowsByUser = new Map();
  for (const escrow of escrows) {
    const buyerId = escrow.buyer?.userId;
    const sellerId = escrow.seller?.userId;
    if (buyerId != null) escrowsByUser.set(buyerId, (escrowsByUser.get(buyerId) || 0) + 1);
    if (sellerId != null) escrowsByUser.set(sellerId, (escrowsByUser.get(sellerId) || 0) + 1);
  }

  let items = users.map((u) => userListItem(u, escrowsByUser));

  if (req.query.search) {
    const q = String(req.query.search).toLowerCase();
    items = items.filter((u) =>
      String(u.id).toLowerCase().includes(q) ||
      String(u.username || "").toLowerCase().includes(q)
    );
  }

  if (req.query.kyc) items = items.filter((u) => (u.kycStatus || "").toLowerCase() === String(req.query.kyc).toLowerCase());
  if (req.query.banned === "true") items = items.filter((u) => u.banned === true);
  if (req.query.banned === "false") items = items.filter((u) => u.banned === false);

  const total = items.length;
  const paged = items.slice(skip, skip + limit);
  res.status(200).json({ users: paged, total, page, limit });
});

router.get("/users/:id", async (req, res) => {
  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const user = await db.collection("users").findOne({ userId });
  if (!user) return res.status(404).json({ message: "User not found" });

  const userEscrows = await db
    .collection("escrows")
    .find({ $or: [{ "buyer.userId": userId }, { "seller.userId": userId }] })
    .toArray();

  const completedEscrows = userEscrows.filter((e) => mapEscrowStatus(e.status, !!e.dispute?.opened) === "complete").length;
  const disputedEscrows = userEscrows.filter((e) => mapEscrowStatus(e.status, !!e.dispute?.opened) === "dispute").length;
  const totalVolume = userEscrows.reduce((sum, e) => sum + Number(e.financials?.amount || 0), 0);

  const sessions = await db.collection("sessions").find({ userId }).sort({ createdAt: -1 }).limit(10).toArray();
  const history = sessions.map((s) => ({
    timestamp: s.createdAt,
    event: `Login from ${s.ip || "unknown ip"}`,
  }));

  res.status(200).json({
    id: user.userId,
    username: user.username,
    email: user.email,
    createdAt: user.createdAt,
    kycStatus: user.kycStatus || "unverified",
    riskScore: Number(user.riskScore ?? 0),
    completedEscrows,
    disputedEscrows,
    totalVolume,
    walletAddress: user.walletAddress || null,
    lastLoginAt: user.lastLogin || null,
    lastIp: sessions[0]?.ip || null,
    banned: !!user.banned,
    flagged: !!user.flagged,
    loginHistory: history,
  });
});

router.post("/users/:id/ban", async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ message: "reason is required" });

  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const result = await db.collection("users").updateOne(
    { userId },
    { $set: { banned: true, banReason: reason, updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });

  await auditLog(req, "user_ban", `user:${userId}`, { reason });
  res.status(200).json({ message: "User banned" });
});

router.post("/users/:id/unban", async (req, res) => {
  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const result = await db.collection("users").updateOne(
    { userId },
    { $set: { banned: false, updatedAt: new Date() }, $unset: { banReason: "" } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });
  await auditLog(req, "user_unban", `user:${userId}`);
  res.status(200).json({ message: "User unbanned" });
});

router.post("/users/:id/freeze-withdrawals", async (req, res) => {
  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const result = await db.collection("users").updateOne(
    { userId },
    { $set: { withdrawalsFrozen: true, updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });
  await auditLog(req, "user_freeze_withdrawals", `user:${userId}`);
  res.status(200).json({ message: "Withdrawals frozen" });
});

router.patch("/users/:id/risk-score", async (req, res) => {
  const score = Number(req.body?.score);
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    return res.status(400).json({ message: "score must be an integer between 0 and 100" });
  }

  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const result = await db.collection("users").updateOne(
    { userId },
    { $set: { riskScore: score, updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });
  await auditLog(req, "user_risk_score", `user:${userId}`, { score });
  res.status(200).json({ message: "Risk score updated" });
});

router.post("/users/:id/verify-kyc", async (req, res) => {
  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const result = await db.collection("users").updateOne(
    { userId },
    { $set: { kycStatus: "verified", updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });
  await auditLog(req, "user_verify_kyc", `user:${userId}`);
  res.status(200).json({ message: "KYC verified" });
});

router.post("/users/:id/reset-2fa", async (req, res) => {
  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const result = await db.collection("users").updateOne(
    { userId },
    { $set: { twoFactorEnabled: false, updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "User not found" });
  await auditLog(req, "user_reset_2fa", `user:${userId}`);
  res.status(200).json({ message: "2FA reset" });
});

router.post("/users/:id/force-logout", async (req, res) => {
  const db = getDB();
  const userId = Number.parseInt(req.params.id, 10);
  const user = await db.collection("users").findOne({ userId });
  if (!user) return res.status(404).json({ message: "User not found" });

  await db.collection("sessions").updateMany({ userId }, { $set: { valid: false } });
  await auditLog(req, "user_force_logout", `user:${userId}`);
  res.status(200).json({ message: "User sessions revoked" });
});

router.get("/disputes", async (req, res) => {
  const db = getDB();
  const { page, limit, skip } = parsePagination(req.query);

  if (req.query.status && !ALLOWED_DISPUTE_STATUS.has(String(req.query.status))) {
    return res.status(400).json({ message: "Invalid dispute status" });
  }
  if (req.query.severity && !ALLOWED_DISPUTE_SEVERITY.has(String(req.query.severity))) {
    return res.status(400).json({ message: "Invalid dispute severity" });
  }

  const docs = await db
    .collection("escrows")
    .find({ $or: [{ "dispute.opened": true }, { status: { $in: ["dispute", "disputed"] } }] })
    .toArray();

  let disputes = docs.map((escrow) => ({
    id: escrow.escrowId,
    escrowId: escrow.escrowId,
    amount: Number(escrow.financials?.amount || 0),
    coin: String(escrow.financials?.currency || "BTC").toUpperCase(),
    severity: getEscrowDisputeSeverity(escrow),
    status: escrow.dispute?.status || "open",
    openedAt: escrow.dispute?.openedAt || escrow.updatedAt || escrow.createdAt,
  }));

  if (req.query.status) disputes = disputes.filter((d) => d.status === req.query.status);
  if (req.query.severity) disputes = disputes.filter((d) => d.severity === req.query.severity);

  const total = disputes.length;
  disputes = disputes.slice(skip, skip + limit);
  res.status(200).json({ disputes, total, page, limit });
});

router.get("/disputes/:id", async (req, res) => {
  const db = getDB();
  const escrow = await db.collection("escrows").findOne({ escrowId: req.params.id });
  if (!escrow) return res.status(404).json({ message: "Dispute not found" });

  res.status(200).json({
    id: escrow.escrowId,
    escrowId: escrow.escrowId,
    amount: Number(escrow.financials?.amount || 0),
    coin: String(escrow.financials?.currency || "BTC").toUpperCase(),
    status: escrow.dispute?.status || "open",
    buyerUsername: escrow.buyer?.username || escrow.buyer?.email || String(escrow.buyer?.userId || ""),
    sellerUsername: escrow.seller?.username || escrow.seller?.email || String(escrow.seller?.userId || ""),
    openedBy: escrow.dispute?.openedBy || "buyer",
    escrowCreatedAt: escrow.createdAt,
    depositConfirmedAt: escrow.depositConfirmedAt || null,
    openedAt: escrow.dispute?.openedAt || escrow.updatedAt || escrow.createdAt,
    timeline: [
      { ts: toIsoOrNull(escrow.createdAt), text: "Escrow created", active: true },
      { ts: toIsoOrNull(escrow.dispute?.openedAt || escrow.updatedAt), text: "Dispute opened", active: true },
    ],
  });
});

router.post("/disputes/:id/resolve", async (req, res) => {
  const { decision, buyerPct, sellerPct, rationale } = req.body || {};
  if (!ALLOWED_DECISIONS.has(decision)) {
    return res.status(400).json({ message: "decision must be release, refund, or split" });
  }

  if (!rationale || !String(rationale).trim()) {
    return res.status(400).json({ message: "rationale is required" });
  }

  if (decision === "split") {
    const buyer = Number(buyerPct);
    const seller = Number(sellerPct);
    if (!Number.isFinite(buyer) || !Number.isFinite(seller) || buyer + seller !== 100) {
      return res.status(400).json({ message: "buyerPct + sellerPct must equal 100" });
    }
  }

  const db = getDB();
  const statusByDecision = { release: "completed", refund: "refunded", split: "completed" };
  const result = await db.collection("escrows").updateOne(
    { escrowId: req.params.id },
    {
      $set: {
        status: statusByDecision[decision],
        "dispute.status": "resolved",
        "dispute.resolved": true,
        "dispute.resolution": { decision, buyerPct, sellerPct, rationale },
        "dispute.resolvedAt": new Date(),
        updatedAt: new Date(),
      },
    }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Dispute not found" });

  await auditLog(req, "dispute_resolve", `dispute:${req.params.id}`, { decision });
  publishAdminLiveFeed({ type: "dispute", text: `Dispute ${req.params.id} resolved (${decision})` });
  res.status(200).json({ message: "Dispute resolved" });
});

router.post("/disputes/:id/escalate", async (req, res) => {
  const db = getDB();
  const result = await db.collection("escrows").updateOne(
    { escrowId: req.params.id },
    { $set: { "dispute.status": "escalated", updatedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Dispute not found" });
  await auditLog(req, "dispute_escalate", `dispute:${req.params.id}`);
  res.status(200).json({ message: "Dispute escalated" });
});

router.post("/disputes/:id/mark-fraud", async (req, res) => {
  const db = getDB();
  const result = await db.collection("escrows").updateOne(
    { escrowId: req.params.id },
    {
      $set: {
        "security.flagged": true,
        "security.flaggedReason": "Marked as fraud by admin",
        updatedAt: new Date(),
      },
    }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Dispute not found" });
  await auditLog(req, "dispute_mark_fraud", `dispute:${req.params.id}`);
  publishAdminLiveFeed({ type: "risk", text: `Fraud flag set for escrow ${req.params.id}` });
  res.status(200).json({ message: "Marked as fraud" });
});

router.get("/addresses", async (req, res) => {
  const db = getDB();
  const escrows = await db.collection("escrows").find({}).toArray();
  const items = escrows
    .map((e) => ({
      address: e.financials?.depositAddress,
      escrowId: e.escrowId,
      coin: String(e.financials?.currency || "BTC").toUpperCase(),
      confirmed: Number(e.financials?.confirmations || 0) > 0,
      balance: Number(e.financials?.amount || 0),
      lockedUtxos: Number(e.lockedUtxos || 0),
      spentUtxos: Number(e.spentUtxos || 0),
    }))
    .filter((x) => !!x.address);

  const totalBtc = items.filter((x) => x.coin === "BTC").reduce((sum, x) => sum + x.balance, 0);
  const totalLtc = items.filter((x) => x.coin === "LTC").reduce((sum, x) => sum + x.balance, 0);
  res.status(200).json({ items, totalBtc, totalLtc, activeAddresses: items.length });
});

router.get("/utxos", async (req, res) => {
  const db = getDB();
  const utxos = await db.collection("utxos").find({}).sort({ value: -1 }).toArray();
  const items = utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: Number(u.value || 0),
    locked: !!u.locked,
    spent: !!u.spent,
    lockedBy: u.lockedBy || null,
    derivationPath: u.derivationPath || null,
  }));
  res.status(200).json({ items });
});

router.get("/withdrawals", async (req, res) => {
  const db = getDB();
  const { page, limit, skip } = parsePagination(req.query);
  const status = String(req.query.status || "");

  if (!ALLOWED_WITHDRAWAL_STATUS.has(status)) {
    return res.status(400).json({ message: "Invalid withdrawal status" });
  }

  const docs = await db.collection("withdrawals").find({}).sort({ createdAt: -1 }).toArray();
  let items = docs.map((w) => ({
    id: w.id || w.withdrawalId || String(w._id),
    username: w.username || w.user || String(w.userId || ""),
    amount: Number(w.amount || 0),
    coin: String(w.coin || "BTC").toUpperCase(),
    destinationAddress: w.destinationAddress || w.dest || null,
    feeRate: Number(w.feeRate ?? w.feerate ?? 0),
    status: w.status || "pending",
  }));

  if (status) items = items.filter((w) => w.status === status);
  const total = items.length;
  const paged = items.slice(skip, skip + limit);
  const pendingWithdrawals = items.filter((w) => w.status === "pending").length;

  res.status(200).json({ withdrawals: paged, total, page, limit, pendingWithdrawals });
});

router.post("/withdrawals/:id/approve", async (req, res) => {
  const db = getDB();
  const result = await db.collection("withdrawals").updateOne(
    { $or: [{ id: req.params.id }, { withdrawalId: req.params.id }] },
    { $set: { status: "broadcast", approvedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Withdrawal not found" });
  await auditLog(req, "withdrawal_approve", `withdrawal:${req.params.id}`);
  publishAdminLiveFeed({ type: "withdrawal", text: `Withdrawal ${req.params.id} approved` });
  res.status(200).json({ message: "Withdrawal approved" });
});

router.post("/withdrawals/:id/reject", async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ message: "reason is required" });

  const db = getDB();
  const result = await db.collection("withdrawals").updateOne(
    { $or: [{ id: req.params.id }, { withdrawalId: req.params.id }] },
    { $set: { status: "rejected", rejectionReason: reason, rejectedAt: new Date() } }
  );
  if (!result.matchedCount) return res.status(404).json({ message: "Withdrawal not found" });
  await auditLog(req, "withdrawal_reject", `withdrawal:${req.params.id}`, { reason });
  res.status(200).json({ message: "Withdrawal rejected" });
});

router.get("/analytics/revenue", async (req, res) => {
  const range = String(req.query.range || "30d");
  if (!ALLOWED_REVENUE_RANGES.has(range)) {
    return res.status(400).json({ message: "Invalid range. Allowed: 7d, 30d, 90d" });
  }

  const db = getDB();
  const escrows = await db.collection("escrows").find({}).toArray();
  const daysCount = Number(range.replace("d", ""));

  const dayMap = new Map();
  for (let i = daysCount - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const label = d.toISOString().slice(5, 10);
    dayMap.set(label, { label, btc: 0, ltc: 0, btcPct: 0, ltcPct: 0 });
  }

  let btcFees = 0;
  let ltcFees = 0;
  let totalAmount = 0;

  for (const escrow of escrows) {
    const createdAt = parseDateSafe(escrow.createdAt);
    const amount = Number(escrow.financials?.amount || 0);
    const coin = String(escrow.financials?.currency || "BTC").toUpperCase();
    totalAmount += amount;

    if (coin === "BTC") btcFees += amount * 0.01;
    if (coin === "LTC") ltcFees += amount * 0.01;

    if (!createdAt) continue;
    const label = createdAt.toISOString().slice(5, 10);
    const row = dayMap.get(label);
    if (!row) continue;

    if (coin === "BTC") row.btc += amount;
    if (coin === "LTC") row.ltc += amount;
  }

  const days = [...dayMap.values()].map((d) => {
    const total = d.btc + d.ltc;
    return {
      ...d,
      btcPct: total > 0 ? Math.round((d.btc / total) * 100) : 0,
      ltcPct: total > 0 ? Math.round((d.ltc / total) * 100) : 0,
    };
  });

  const avgSize = escrows.length ? totalAmount / escrows.length : 0;
  const disputeCount = escrows.filter((e) => !!e.dispute?.opened).length;
  const disputeRate = escrows.length ? Math.round((disputeCount / escrows.length) * 100) : 0;

  res.status(200).json({ btcFees, ltcFees, avgSize, disputeRate, days });
});

router.get("/analytics/balances", async (req, res) => {
  const db = getDB();
  const escrows = await db.collection("escrows").find({}).toArray();
  const btc = escrows
    .filter((e) => String(e.financials?.currency || "BTC").toUpperCase() === "BTC")
    .reduce((sum, e) => sum + Number(e.financials?.amount || 0), 0);
  const ltc = escrows
    .filter((e) => String(e.financials?.currency || "BTC").toUpperCase() === "LTC")
    .reduce((sum, e) => sum + Number(e.financials?.amount || 0), 0);
  const total = Math.max(1, btc + ltc);

  const breakdown = [
    { label: "BTC", value: btc, pct: Math.round((btc / total) * 100) },
    { label: "LTC", value: ltc, pct: Math.round((ltc / total) * 100) },
  ];

  res.status(200).json({ breakdown });
});

router.get("/analytics/kpis", async (req, res) => {
  const db = getDB();
  const escrows = await db.collection("escrows").find({}).toArray();
  const resolvedDisputes = escrows.filter((e) => e.dispute?.resolved).length;
  const disputes = escrows.filter((e) => e.dispute?.opened).length;
  const completed = escrows.filter((e) => mapEscrowStatus(e.status, !!e.dispute?.opened) === "complete").length;

  const kpis = {
    fraudRate: escrows.length ? Math.round((escrows.filter((e) => e.security?.flagged).length / escrows.length) * 100) : 0,
    avgResolutionTime: disputes ? 48 : 0,
    successRate: escrows.length ? Math.round((completed / escrows.length) * 100) : 0,
    retention30d: 0,
    btcFees: escrows
      .filter((e) => String(e.financials?.currency || "BTC").toUpperCase() === "BTC")
      .reduce((sum, e) => sum + Number(e.financials?.amount || 0) * 0.01, 0),
    ltcFees: escrows
      .filter((e) => String(e.financials?.currency || "BTC").toUpperCase() === "LTC")
      .reduce((sum, e) => sum + Number(e.financials?.amount || 0) * 0.01, 0),
    avgSize: escrows.length ? escrows.reduce((sum, e) => sum + Number(e.financials?.amount || 0), 0) / escrows.length : 0,
    disputeRate: escrows.length ? Math.round((disputes / escrows.length) * 100) : 0,
    resolvedDisputes,
  };

  res.status(200).json({ kpis });
});

router.get("/risk/events", async (req, res) => {
  const db = getDB();
  const events = await db.collection("risk_events").find({}).sort({ createdAt: -1 }).toArray();
  const items = events.map((e) => ({
    id: String(e._id),
    severity: e.severity || "low",
    status: e.status || "open",
    type: e.type || e.eventType || "risk",
    username: e.username || e.user || "unknown",
    detail: e.detail || e.description || "",
  }));
  res.status(200).json({ events: items });
});

router.get("/risk/thresholds", async (req, res) => {
  const db = getDB();
  const thresholds = await getSingletonConfig(db, "risk_thresholds", {
    freezeThreshold: 85,
    kycAmountBtc: 0.5,
    escrowRateLimit: 10,
  });
  res.status(200).json(thresholds);
});

router.patch("/risk/thresholds", async (req, res) => {
  const payload = req.body || {};
  await setSingletonConfig(getDB(), "risk_thresholds", payload);
  await auditLog(req, "risk_thresholds_update", "risk_thresholds", payload);
  res.status(200).json({ message: "Risk thresholds updated" });
});

router.post("/risk/events/:id/dismiss", async (req, res) => {
  const db = getDB();
  const result = await db.collection("risk_events").updateOne(
    { _id: req.params.id },
    { $set: { status: "dismissed", updatedAt: new Date() } }
  );
  if (!result.matchedCount) {
    await db.collection("risk_events").updateMany({ id: req.params.id }, { $set: { status: "dismissed" } });
  }
  await auditLog(req, "risk_event_dismiss", `risk_event:${req.params.id}`);
  res.status(200).json({ message: "Risk event dismissed" });
});

router.post("/risk/events/:id/escalate", async (req, res) => {
  const db = getDB();
  const result = await db.collection("risk_events").updateOne(
    { _id: req.params.id },
    { $set: { status: "escalated", severity: "critical", updatedAt: new Date() } }
  );
  if (!result.matchedCount) {
    await db.collection("risk_events").updateMany({ id: req.params.id }, { $set: { status: "escalated", severity: "critical" } });
  }
  await auditLog(req, "risk_event_escalate", `risk_event:${req.params.id}`);
  publishAdminLiveFeed({ type: "risk", text: `Risk event ${req.params.id} escalated` });
  res.status(200).json({ message: "Risk event escalated" });
});

router.get("/audit", async (req, res) => {
  const db = getDB();
  const { page, limit, skip } = parsePagination(req.query);

  const filters = {};
  if (req.query.action) filters.action = req.query.action;
  if (req.query.from || req.query.to) {
    filters.ts = {};
    if (req.query.from) {
      const from = parseDateSafe(req.query.from);
      if (!from) return res.status(400).json({ message: "Invalid from date" });
      filters.ts.$gte = from;
    }
    if (req.query.to) {
      const to = parseDateSafe(req.query.to);
      if (!to) return res.status(400).json({ message: "Invalid to date" });
      filters.ts.$lte = to;
    }
  }

  const rows = await db.collection("admin_audit_logs").find(filters).sort({ ts: -1 }).toArray();
  let items = rows.map((r) => ({
    timestamp: r.ts,
    ts: r.ts,
    adminId: r.adminId || r.admin,
    admin: r.admin,
    action: r.action,
    actionType: r.actionType || r.action,
    target: r.target,
    targetEntity: r.targetEntity || r.target,
    ip: r.ip,
    ipAddress: r.ipAddress || r.ip,
  }));

  if (req.query.search) {
    const q = String(req.query.search).toLowerCase();
    items = items.filter((i) =>
      String(i.admin || "").toLowerCase().includes(q) ||
      String(i.action || "").toLowerCase().includes(q) ||
      String(i.target || "").toLowerCase().includes(q)
    );
  }

  const total = items.length;
  const paged = items.slice(skip, skip + limit);
  res.status(200).json({ logs: paged, total, page, limit });
});

router.post("/audit/export", async (req, res) => {
  const db = getDB();
  const filters = {};
  const { search, action, from, to } = req.body || {};

  if (action) filters.action = action;
  if (from || to) {
    filters.ts = {};
    if (from) {
      const f = parseDateSafe(from);
      if (!f) return res.status(400).json({ message: "Invalid from date" });
      filters.ts.$gte = f;
    }
    if (to) {
      const t = parseDateSafe(to);
      if (!t) return res.status(400).json({ message: "Invalid to date" });
      filters.ts.$lte = t;
    }
  }

  let rows = await db.collection("admin_audit_logs").find(filters).sort({ ts: -1 }).toArray();
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) =>
      String(r.admin || r.adminId || "").toLowerCase().includes(q) ||
      String(r.action || "").toLowerCase().includes(q) ||
      String(r.target || "").toLowerCase().includes(q)
    );
  }

  const mapped = rows.map((r) => ({
    timestamp: toIsoOrNull(r.ts),
    adminId: r.adminId || r.admin,
    action: r.action,
    target: r.target,
    ip: r.ip || r.ipAddress || "",
  }));

  const csv = asCsv(mapped, ["timestamp", "adminId", "action", "target", "ip"]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"audit-export-${Date.now()}.csv\"`);
  res.status(200).send(csv);
});

router.get("/settings", async (req, res) => {
  const db = getDB();
  const settings = await getSingletonConfig(db, "admin_settings", {
    platformFeePct: 1,
    minEscrowBtc: 0.0001,
    maxEscrowBtc: 5,
    autoReleaseHours: 24,
    btcEnabled: true,
    ltcEnabled: true,
    maintenanceMode: false,
    autoFreezeEnabled: true,
    kycRequiredEnabled: false,
  });
  res.status(200).json(settings);
});

router.patch("/settings", async (req, res) => {
  const settings = req.body || {};
  await setSingletonConfig(getDB(), "admin_settings", settings);
  await auditLog(req, "settings_update", "admin_settings", settings);
  res.status(200).json({ message: "Settings updated" });
});

export default router;
