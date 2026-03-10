import jwt from "jsonwebtoken";
import { findBySessionId } from "../models/SessionStore.js";
import { findByUserId } from "../models/UserStore.js";

export async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies.accessToken;

    if (!token) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    const sessionId = decoded.sessionId;
    const userId = decoded.userId;

    // Check session
    const session = await findBySessionId(sessionId);
    if (!session || !session.valid) {
      return res.status(401).json({ message: "Session expired or invalid" });
    }

    if (session.expiresAt < new Date()) {
      return res.status(401).json({ message: "Session has expired" });
    }

    // Fetch user
    const user = await findByUserId(userId);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Attach to request (very important)
    req.user = {
      userId: user.userId,
      username: user.username,
      email: user.email,
      sessionId: session.sessionId,
    };

    next();
  } catch (error) {
    console.error("Auth Middleware Error:", error);
    res.status(500).json({ message: "Authentication error", error });
  }
}
