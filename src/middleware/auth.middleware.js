import jwt from "jsonwebtoken";
import { findBySessionId } from "../models/SessionStore.js";
import { findByUserId } from "../models/User.js";

function extractAccessToken(req) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const bearerToken = authHeader.substring(7).trim();
    if (bearerToken) {
      return bearerToken;
    }
  }

  return req.cookies?.accessToken || null;
}

/**
 * Core authentication middleware.
 *
 * Verifies the JWT access token from the httpOnly cookie,
 * validates the linked session, and attaches `req.user` with
 * userId, username, email, roles, and sessionId.
 */
export async function authenticate(req, res, next) {
  try {
    const token = extractAccessToken(req);

    if (!token) {
      return res.status(401).json({ logout: true, message: "Not authenticated" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ logout: true, message: "Invalid or expired token" });
    }

    const { sessionId, userId } = decoded;

    // Validate session
    const session = await findBySessionId(sessionId);
    if (!session || !session.valid) {
      return res.status(401).json({ logout: true, message: "Session expired or invalid" });
    }

    if (session.expiresAt < new Date()) {
      return res.status(401).json({ logout: true, message: "Session has expired" });
    }

    // Fetch user
    const user = await findByUserId(userId);
    if (!user) {
      return res.status(401).json({ logout: true, message: "User not found" });
    }

    // Attach authenticated user to the request
    req.user = {
      userId: user.userId,
      username: user.username,
      email: user.email,
      roles: user.roles || ["user"],
      sessionId: session.sessionId,
    };

    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    res.status(500).json({ message: "Authentication error" });
  }
}

/**
 * Role-based access control middleware factory.
 *
 * Requires `authenticate` to have run first so `req.user` exists.
 *
 * @example
 *   router.get("/admin/users", authenticate, requireRole("admin"), handler);
 *   router.post("/moderate", authenticate, requireRole("admin", "support"), handler);
 *
 * @param  {...string} allowedRoles  One or more roles that grant access.
 * @returns {Function} Express middleware
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const userRoles = req.user.roles || [];
    const hasRole = allowedRoles.some((role) => userRoles.includes(role));

    if (!hasRole) {
      return res.status(403).json({ message: "Insufficient permissions" });
    }

    next();
  };
}

/**
 * Ownership check middleware for escrow routes.
 *
 * Verifies the authenticated user is either the buyer or the seller
 * of the escrow identified by `req.params.id`, `req.params.escrowId`,
 * or `req.body.escrowId`.
 *
 * Attaches `req.escrow` on success.
 *
 * @param {Function} getEscrowFn  Async function(escrowId) → escrow doc
 * @returns {Function} Express middleware
 */
export function requireEscrowParty(getEscrowFn) {
  return async (req, res, next) => {
    try {
      const escrowId = req.params.id || req.params.escrowId || req.body.escrowId;
      if (!escrowId) {
        return res.status(400).json({ message: "Escrow ID is required" });
      }

      const escrow = await getEscrowFn(escrowId);
      if (!escrow) {
        return res.status(404).json({ message: "Escrow not found" });
      }

      const buyerId = escrow.buyer?.userId || escrow.buyerId;
      const sellerId = escrow.seller?.userId || escrow.sellerId;

      if (req.user.userId !== buyerId && req.user.userId !== sellerId) {
        return res.status(403).json({ message: "You are not a party to this escrow" });
      }

      req.escrow = escrow;
      next();
    } catch (error) {
      console.error("Escrow Party Check Error:", error);
      res.status(500).json({ message: "Authorization error" });
    }
  };
}

/* Backwards-compatible alias */
export const authMiddleware = authenticate;
