import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { findByEmail } from "../models/User.js";

const adminSessions = new Map();

const ACCESS_TOKEN_EXPIRY = process.env.ADMIN_TOKEN_EXPIRY || "8h";
const ADMIN_SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
const ADMIN_SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const ADMIN_SESSION_COOKIE_NAME = process.env.ADMIN_SESSION_COOKIE_NAME || "sessionToken";

const adminSessionCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [sessionId, session] of adminSessions.entries()) {
    if (!session || !session.valid || session.expiresAt.getTime() <= now) {
      adminSessions.delete(sessionId);
    }
  }
}, ADMIN_SESSION_CLEANUP_INTERVAL_MS);
adminSessionCleanupTimer.unref?.();

function getAdminJwtSecret() {
  return process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
}

function isSessionActive(session) {
  return !!session && session.valid && session.expiresAt > new Date();
}

function hasAdminRole(user) {
  if (!Array.isArray(user?.roles)) return false;
  return user.roles.some((role) => ["admin", "superadmin"].includes(String(role || "").toLowerCase()));
}

function normalizeDbAdmin(user) {
  const roles = Array.isArray(user?.roles) ? user.roles.map((role) => String(role || "").toLowerCase()) : [];
  const effectiveRole = roles.includes("superadmin") ? "Super Admin" : "Admin";
  return {
    id: String(user.userId ?? user._id ?? "admin"),
    username: user.username || user.displayName || user.email || "admin",
    role: effectiveRole,
  };
}

export async function createAdminSession({ email, password, ip }) {
  if (!email || !password) return null;

  const dbUser = await findByEmail(email);
  const canUseDbAdminAuth =
    dbUser &&
    hasAdminRole(dbUser) &&
    typeof dbUser.passwordHash === "string" &&
    dbUser.passwordHash.length > 0;

  if (!canUseDbAdminAuth) {
    return null;
  }

  const validDbPassword = await bcrypt.compare(password, dbUser.passwordHash);
  if (!validDbPassword) {
    return null;
  }

  const adminIdentity = normalizeDbAdmin(dbUser);

  const sessionId = randomUUID();
  const tokenId = randomUUID();
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);

  adminSessions.set(sessionId, {
    id: sessionId,
    adminId: adminIdentity.id,
    admin: adminIdentity.username,
    role: adminIdentity.role,
    ip: ip || null,
    since: new Date(),
    createdAt: new Date(),
    expiresAt,
    tokenId,
    valid: true,
  });

  const secret = getAdminJwtSecret();
  if (!secret) {
    throw new Error("Admin auth secret is not configured");
  }

  const token = jwt.sign(
    {
      sid: sessionId,
      jti: tokenId,
      adminId: adminIdentity.id,
      username: adminIdentity.username,
      role: adminIdentity.role,
    },
    secret,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  return {
    token,
    admin: {
      id: adminIdentity.id,
      username: adminIdentity.username,
      role: adminIdentity.role,
    },
    sessionId,
  };
}

export function listAdminSessions() {
  const now = new Date();
  const sessions = [];

  for (const session of adminSessions.values()) {
    if (session.expiresAt <= now || !session.valid) continue;
    sessions.push({
      id: session.id,
      adminId: session.adminId,
      admin: session.admin,
      role: session.role,
      ip: session.ip,
      since: session.since,
      createdAt: session.createdAt,
    });
  }

  sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return sessions;
}

export function revokeAdminSession(sessionId) {
  const existing = adminSessions.get(sessionId);
  if (!existing) return false;
  existing.valid = false;
  adminSessions.set(sessionId, existing);
  return true;
}

export function revokeTokenSession(token) {
  try {
    const secret = getAdminJwtSecret();
    const decoded = jwt.verify(token, secret);
    const session = adminSessions.get(decoded.sid);
    if (!session) return false;
    session.valid = false;
    adminSessions.set(decoded.sid, session);
    return true;
  } catch {
    return false;
  }
}

export function authenticateAdminToken(token) {
  const secret = getAdminJwtSecret();
  if (!secret) {
    return { ok: false, status: 500, message: "Admin auth secret is not configured" };
  }

  if (!token) {
    return { ok: false, status: 401, message: "Missing admin session token" };
  }

  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    return { ok: false, status: 401, message: "Invalid or expired admin token" };
  }

  if (typeof decoded?.sid !== "string" || typeof decoded?.jti !== "string") {
    return { ok: false, status: 401, message: "Invalid admin token payload" };
  }

  const session = adminSessions.get(decoded.sid);
  if (!isSessionActive(session)) {
    return { ok: false, status: 403, message: "Admin session expired or revoked" };
  }

  if (session.tokenId !== decoded.jti) {
    return { ok: false, status: 403, message: "Invalid admin session" };
  }

  return {
    ok: true,
    admin: {
      id: decoded.adminId,
      username: decoded.username,
      role: decoded.role,
      sessionId: decoded.sid,
      tokenId: decoded.jti,
    },
  };
}

export function authenticateAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ message: "Missing admin session token" });
  }

  const result = authenticateAdminToken(token);
  if (!result.ok) {
    return res.status(result.status).json({ message: result.message });
  }

  req.admin = result.admin;
  req.adminToken = token;
  next();
}

export function setAdminSessionCookie(res, token) {
  res.cookie(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: ADMIN_SESSION_MAX_AGE,
    path: "/",
  });
}

export function clearAdminSessionCookie(res) {
  res.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
  });
}
