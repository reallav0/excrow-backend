import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import axios from "axios";
import querystring from "querystring";

import {
  createLocalUser,
  findByEmail,
  findByUsername,
  createOrUpdateOAuthUser,
} from "../models/User.js";

import {
  createSession,
  invalidateAllUserSessions,
  invalidateSession,
  findByRefreshToken,
  rotateRefreshToken,
} from "../models/SessionStore.js";

import {
  validatePassword,
  validateEmail,
  validateUsername,
} from "../utils/validator.js";

const router = express.Router();

/* ============ LOGIN BRUTE-FORCE PROTECTION ============ */
const loginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function checkLoginLockout(email) {
  const key = email.toLowerCase();
  const record = loginAttempts.get(key);
  if (!record) return { locked: false };
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
  }
  if (record.firstAttempt + ATTEMPT_WINDOW_MS < Date.now()) {
    loginAttempts.delete(key);
    return { locked: false };
  }
  return { locked: false };
}

function recordFailedLogin(email) {
  const key = email.toLowerCase();
  const record = loginAttempts.get(key) || { count: 0, firstAttempt: Date.now() };
  record.count++;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  loginAttempts.set(key, record);
}

function clearLoginAttempts(email) {
  loginAttempts.delete(email.toLowerCase());
}

// Cleanup stale lockout records every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of loginAttempts.entries()) {
    if (record.firstAttempt + ATTEMPT_WINDOW_MS < now && (!record.lockedUntil || record.lockedUntil < now)) {
      loginAttempts.delete(key);
    }
  }
}, 30 * 60 * 1000);

/* ============ TOKEN / COOKIE HELPERS ============ */
const ACCESS_TOKEN_EXPIRY = "15m";
const ACCESS_COOKIE_MAX_AGE = 15 * 60 * 1000; // 15 min
const REFRESH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function sanitizeEnvString(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^['"]|['"]$/g, "");
}

const GOOGLE_CLIENT_ID = sanitizeEnvString(process.env.GOOGLE_CLIENT_ID);
const GOOGLE_CLIENT_SECRET = sanitizeEnvString(process.env.GOOGLE_CLIENT_SECRET);
const DISCORD_CLIENT_ID = sanitizeEnvString(process.env.DISCORD_CLIENT_ID);
const DISCORD_CLIENT_SECRET = sanitizeEnvString(process.env.DISCORD_CLIENT_SECRET);

const GOOGLE_CALLBACK_URL =
  sanitizeEnvString(process.env.GOOGLE_CALLBACK_URL) || "http://localhost:3001/api/auth/google/callback";
const DISCORD_REDIRECT =
  sanitizeEnvString(process.env.DISCORD_REDIRECT) || "http://localhost:3001/api/auth/discord/callback";
const FRONTEND_ORIGIN =
  (process.env.FRONTEND_URL || "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)[0] || "http://localhost:3000";
const OAUTH_SUCCESS_PATH = process.env.OAUTH_SUCCESS_PATH || "/dashboard";

const hasGoogleOAuthConfig =
  Boolean(GOOGLE_CLIENT_ID) && Boolean(GOOGLE_CLIENT_SECRET);
const hasDiscordOAuthConfig =
  Boolean(DISCORD_CLIENT_ID) && Boolean(DISCORD_CLIENT_SECRET);

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: ACCESS_COOKIE_MAX_AGE,
  });
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    maxAge: REFRESH_COOKIE_MAX_AGE,
    path: "/api/auth",
  });
}

function clearAuthCookies(res) {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken", { path: "/api/auth" });
}

function buildFrontendRedirect(pathname = "/") {
  try {
    return new URL(pathname, FRONTEND_ORIGIN).toString();
  } catch {
    return `http://localhost:3000${pathname}`;
  }
}

// Function to verify reCAPTCHA
async function verifyRecaptcha(captchaToken) {
  const isProd = process.env.NODE_ENV === "production";
  const secret = process.env.RECAPTCHA_SECRET_KEY;

  // In non-production, allow local development without CAPTCHA wiring.
  if (!isProd && (!secret || !captchaToken)) {
    return true;
  }

  if (!secret || !captchaToken) {
    return false;
  }

  try {
    const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
      params: {
        secret,
        response: captchaToken,
      },
    });
    return response.data.success;
  } catch (error) {
    console.error('reCAPTCHA verification error:', error);
    return false;
  }
}

/* ------------------ REGISTER ------------------ */
router.post("/register", async (req, res) => {
  try {
    const { username, email, password, birthdate, captchaToken } = req.body;

    // Verify reCAPTCHA
    const isCaptchaValid = await verifyRecaptcha(captchaToken);
    if (!isCaptchaValid) {
      return res.status(400).json({ message: "reCAPTCHA verification failed" });
    }

    if (!username || !email || !password || !birthdate) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Validate input formats
    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      return res.status(400).json({ message: emailCheck.errors[0] });
    }

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.valid) {
      return res.status(400).json({ message: usernameCheck.errors[0] });
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ message: passwordCheck.errors[0], errors: passwordCheck.errors });
    }

    // Username exists?
    if (await findByUsername(username)) {
      return res.status(400).json({ message: "Username already in use" });
    }

    // Email exists?
    if (await findByEmail(email)) {
      return res.status(400).json({ message: "Email already in use" });
    }

    // Create user
    const user = await createLocalUser({
      username,
      email,
      password,
      birthdate,
    });

    // Create session with refresh token
    const sessionId = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

    await createSession({
      sessionId,
      userId: user.userId,
      refreshToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      expiresAt,
    });

    // Short-lived access token (15 min)
    const accessToken = jwt.sign(
      { sessionId, userId: user.userId },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    setAuthCookies(res, accessToken, refreshToken);

    res.status(201).json({
      message: "Registration successful",
      username: user.username,
    });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ message: "Error registering user" });
  }
});

/* ------------------ LOGIN ------------------ */
router.post("/login", async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    // Verify reCAPTCHA
    const isCaptchaValid = await verifyRecaptcha(captchaToken);
    if (!isCaptchaValid) {
      return res.status(400).json({ message: "reCAPTCHA verification failed" });
    }

    // Check brute-force lockout
    const lockout = checkLoginLockout(email);
    if (lockout.locked) {
      return res.status(429).json({
        message: "Too many failed login attempts. Please try again later.",
        retryAfter: lockout.retryAfter,
      });
    }

    const user = await findByEmail(email);

    // Generic message to prevent user enumeration
    if (!user) {
      recordFailedLogin(email);
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // FIX: use async bcrypt.compare instead of compareSync
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      recordFailedLogin(email);
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Successful login → clear lockout tracker
    clearLoginAttempts(email);

    await invalidateAllUserSessions(user.userId);

    // Create new session with refresh token
    const sessionId = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

    await createSession({
      sessionId,
      userId: user.userId,
      refreshToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      expiresAt,
    });

    // Short-lived access token (15 min)
    const accessToken = jwt.sign(
      { sessionId, userId: user.userId },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    setAuthCookies(res, accessToken, refreshToken);

    res.status(200).json({
      message: "Login successful",
      username: user.username,
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Error logging in" });
  }
});

function generateState(res) {
  const state = randomUUID();
  res.cookie("oauth_state", state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
  });
  return state;
}

function validateState(req) {
  return (
    typeof req.query.state === "string" &&
    req.query.state === req.cookies.oauth_state
  );
}
/* ======================================================
   GOOGLE OAUTH
====================================================== */
if (hasGoogleOAuthConfig) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      async (_, __, profile, done) => done(null, profile)
    )
  );
}

function requireGoogleOAuthConfig(req, res, next) {
  if (!hasGoogleOAuthConfig) {
    return res.status(503).json({ message: "Google OAuth is not configured" });
  }
  return next();
}

function requireDiscordOAuthConfig(req, res, next) {
  if (!hasDiscordOAuthConfig) {
    return res.status(503).json({ message: "Discord OAuth is not configured" });
  }
  return next();
}

router.get("/google", requireGoogleOAuthConfig, (req, res, next) => {
  const state = generateState(res);
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state,
  })(req, res, next);
});

router.get(
  "/google/callback",
  requireGoogleOAuthConfig,
  passport.authenticate("google", {
    session: false,
    failureRedirect: "/",
  }),
  async (req, res) => {
    if (!validateState(req)) {
      return res.status(403).json({ message: "Invalid OAuth state" });
    }
    res.clearCookie("oauth_state");

    const emailObj = req.user.emails?.[0];
    if (!emailObj || emailObj.verified !== true) {
      return res.status(403).json({ message: "Google email not verified" });
    }

    await handleSocialLogin({
      provider: "google",
      providerId: req.user.id,
      username: req.user.displayName,
      email: emailObj.value,
      avatar: req.user.photos?.[0]?.value || "",
      req,
      res,
    });
  }
);

/* ======================================================
   DISCORD OAUTH
====================================================== */
router.get("/discord", requireDiscordOAuthConfig, (req, res) => {
  const state = generateState(res);

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT,
    response_type: "code",
    scope: "identify email",
    state,
  });

  res.redirect(
    `https://discord.com/oauth2/authorize?${params.toString()}`
  );
});

router.get("/discord/callback", requireDiscordOAuthConfig, async (req, res) => {
  if (
    typeof req.query.state !== "string" ||
    req.query.state !== req.cookies.oauth_state
  ) {
    return res.status(403).json({ message: "Invalid OAuth state" });
  }

  res.clearCookie("oauth_state");

  const code = req.query.code;
  if (!code) {
    return res.status(400).json({ message: "Missing OAuth code" });
  }

  try {
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      querystring.stringify({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenRes.data.access_token;
    if (!accessToken) {
      return res
        .status(401)
        .json({ message: "Failed to obtain Discord access token" });
    }

    const userRes = await axios.get(
      "https://discord.com/api/users/@me",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const { id, username, email, avatar } = userRes.data;

    if (!id || !username) {
      return res
        .status(400)
        .json({ message: "Invalid Discord user data" });
    }

    if (!email) {
      return res.status(403).json({ message: "Discord account email is required" });
    }

    await handleSocialLogin({
      provider: "discord",
      providerId: id,
      username,
      email: email || null,
      avatar: avatar
        ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`
        : null,
      req,
      res,
    });
  } catch (err) {
    console.error("Discord OAuth Error:", err.response?.data || err);

    if (err.response?.data?.error === "invalid_client") {
      return res.status(500).json({
        message: "Discord OAuth client configuration is invalid",
      });
    }

    res.status(500).json({ message: "Discord authentication failed" });
  }
});


/* ======================================================
   TOKEN REFRESH ENDPOINT
====================================================== */
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ logout: true, message: "No refresh token" });
    }

    // Find valid session by refresh token
    const session = await findByRefreshToken(refreshToken);
    if (!session || !session.valid || session.expiresAt < new Date()) {
      clearAuthCookies(res);
      return res.status(401).json({ logout: true, message: "Session expired" });
    }

    // Rotate refresh token (prevents reuse / replay)
    const newRefreshToken = randomUUID();
    await rotateRefreshToken(session.sessionId, newRefreshToken);

    // Issue new short-lived access token
    const accessToken = jwt.sign(
      { sessionId: session.sessionId, userId: session.userId },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    setAuthCookies(res, accessToken, newRefreshToken);

    res.status(200).json({ message: "Token refreshed" });
  } catch (error) {
    console.error("Refresh Error:", error);
    res.status(500).json({ message: "Error refreshing token" });
  }
});

/* ======================================================
   LOGOUT ENDPOINT
====================================================== */
router.post("/logout", async (req, res) => {
  try {
    const token = req.cookies.accessToken;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
        await invalidateSession(decoded.sessionId);
      } catch {
        // Token malformed — just clear cookies
      }
    }

    clearAuthCookies(res);
    res.status(200).json({ message: "Logged out" });
  } catch (error) {
    console.error("Logout Error:", error);
    res.status(500).json({ message: "Error logging out" });
  }
});

/* ======================================================
   🔐 CENTRAL OAUTH LOGIN HANDLER
====================================================== */
async function handleSocialLogin({
  provider,
  providerId,
  username,
  email,
  avatar,
  req,
  res,
}) {
  try {
    const user = await createOrUpdateOAuthUser(provider, {
      providerId,
      email,
      username,
      avatar,
    });

    await invalidateAllUserSessions(user.userId);

    const sessionId = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_EXPIRY_MS);

    await createSession({
      sessionId,
      userId: user.userId,
      refreshToken,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      expiresAt,
    });

    const accessToken = jwt.sign(
      { sessionId, userId: user.userId },
      process.env.JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );

    setAuthCookies(res, accessToken, refreshToken);

    return res.redirect(302, buildFrontendRedirect(OAUTH_SUCCESS_PATH));
  } catch (err) {
    console.error(`${provider} login error:`, err);
    res.status(500).json({ message: "Authentication failed" });
  }
}

export default router;