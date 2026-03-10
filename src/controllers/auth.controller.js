import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";
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
} from "../models/SessionStore.js";

const router = express.Router();

// Function to verify reCAPTCHA
async function verifyRecaptcha(captchaToken) {
  try {
    const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', null, {
      params: {
        secret: process.env.RECAPTCHA_SECRET_KEY,
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

    // Create session
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await createSession({
      sessionId,
      userId: user.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      expiresAt,
    });

    // Create JWT
    const token = jwt.sign(
      {
        sessionId,
        userId: user.userId,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Set cookie
    res.cookie("accessToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({
      message: "Registration successful",
      username: user.username,
    });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ message: "Error registering user", error });
  }
});

/* ------------------ LOGIN ------------------ */
router.post("/login", async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body;

    // Verify reCAPTCHA
    const isCaptchaValid = await verifyRecaptcha(captchaToken);
    if (!isCaptchaValid) {
      return res.status(400).json({ message: "reCAPTCHA verification failed" });
    }

    const user = await findByEmail(email);
 
    if (!user) {
      return res.status(400).json({ message: "Email not found!" });
    }

    const valid = await bcrypt.compareSync(password, user.passwordHash);
    if (!valid) {
      return res.status(400).json({ message: "Wrong email/password combination!" });
    }

 
    await invalidateAllUserSessions(user.userId);

    // Create new session
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await createSession({
      sessionId,
      userId: user.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      expiresAt,
    });

    // Create JWT
    const token = jwt.sign(
      {
        sessionId,
        userId: user.userId,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Set cookie
    res.cookie("accessToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      username: user.username,
    });
  }catch{

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
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3001/api/auth/google/callback",
    },
    async (_, __, profile, done) => done(null, profile)
  )
);

router.get("/google", (req, res, next) => {
  const state = generateState(res);
  passport.authenticate("google", {
    scope: ["profile", "email"],
    state,
  })(req, res, next);
});

router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    failureRedirect: "/",
  }),
  async (req, res) => {
    if (!validateState(req)) {
      return res.status(403).json({ message: "Invalid OAuth state" });
    }

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
   FACEBOOK OAUTH
====================================================== */
/*
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      callbackURL: "http://localhost:3001/api/auth/facebook/callback",
      profileFields: ["id", "emails", "displayName"],
    },
    async (_, __, profile, done) => done(null, profile)
  )
);

router.get("/facebook", (req, res, next) => {
  const state = generateState(res);
  passport.authenticate("facebook", {
    scope: ["email"],
    state,
  })(req, res, next);
});

router.get(
  "/facebook/callback",
  passport.authenticate("facebook", {
    session: false,
    failureRedirect: "/",
  }),
  async (req, res) => {
    if (!validateState(req)) {
      return res.status(403).json({ message: "Invalid OAuth state" });
    }

    const email = req.user.emails?.[0]?.value || null;

    await handleSocialLogin({
      provider: "facebook",
      providerId: req.user.id,
      username: req.user.displayName,
      email,
      avatar: `https://graph.facebook.com/${req.user.id}/picture?type=large`,
      req,
      res,
    });
  }
);
*/
/* ======================================================
   DISCORD OAUTH
====================================================== */
router.get("/discord", (req, res) => {
  const state = generateState(res);

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT,
    response_type: "code",
    scope: "identify email",
    state,
  });

  res.redirect(
    `https://discord.com/oauth2/authorize?${params.toString()}`
  );
});
const DISCORD_REDIRECT =
  "http://localhost:3001/api/auth/discord/callback";

router.get("/discord/callback", async (req, res) => {
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
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
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
    res.status(500).json({ message: "Discord authentication failed" });
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
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await createSession({
      sessionId,
      userId: user.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      expiresAt,
    });

    const token = jwt.sign(
      { sessionId, userId: user.userId },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    res.cookie("accessToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      maxAge: 15 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      username: user.username,
    });
  } catch (err) {
    console.error(`${provider} login error:`, err);
    res.status(500).json({ message: "Authentication failed" });
  }
}

export default router;