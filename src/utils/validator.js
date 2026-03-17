/**
 * Input Validation & Sanitization Utilities
 *
 * Centralised validation for all user input.
 * Used by controllers to enforce strong input rules.
 */

/* ============ COMMON PASSWORD BLOCKLIST ============ */
const COMMON_PASSWORDS = new Set([
  "password", "123456", "12345678", "qwerty", "abc123", "monkey", "1234567",
  "letmein", "trustno1", "dragon", "baseball", "iloveyou", "master", "sunshine",
  "ashley", "michael", "shadow", "123123", "654321", "superman", "qazwsx",
  "password1", "password123", "admin", "welcome", "hello", "charlie", "donald",
  "login", "princess", "starwars", "passw0rd", "whatever", "qwerty123",
  "football", "unknown", "access", "flower", "hottie", "loveme", "zaq1zaq1",
  "000000", "111111", "121212", "1q2w3e", "1234", "12345", "123456789",
  "1234567890", "password1234", "iloveu", "000000", "abcdef", "abcdefg",
  "987654321", "qwertyuiop", "mypassword", "passcode", "passwd", "test1234",
  "changeme", "letmein1", "p@ssw0rd", "p@ssword", "secret", "trustme",
]);

/* ============ CONSTANTS ============ */
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 128;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 30;
const EMAIL_MAX_LENGTH = 254;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/* ============ PASSWORD VALIDATION ============ */
/**
 * Validate password strength (min 12 chars, upper, lower, digit, special, not common).
 * @param {string} password
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePassword(password) {
  const errors = [];

  if (!password || typeof password !== "string") {
    return { valid: false, errors: ["Password is required"] };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter");
  }

  if (!/[0-9]/.test(password)) {
    errors.push("Password must contain at least one number");
  }

  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push("Password must contain at least one special character");
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push("This password is too common. Please choose a stronger password");
  }

  return { valid: errors.length === 0, errors };
}

/* ============ EMAIL VALIDATION ============ */
/**
 * @param {string} email
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEmail(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, errors: ["Email is required"] };
  }
  if (email.length > EMAIL_MAX_LENGTH) {
    return { valid: false, errors: ["Email is too long"] };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, errors: ["Invalid email format"] };
  }
  return { valid: true, errors: [] };
}

/* ============ USERNAME VALIDATION ============ */
/**
 * @param {string} username
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateUsername(username) {
  const errors = [];

  if (!username || typeof username !== "string") {
    return { valid: false, errors: ["Username is required"] };
  }

  if (username.length < USERNAME_MIN_LENGTH) {
    errors.push(`Username must be at least ${USERNAME_MIN_LENGTH} characters`);
  }

  if (username.length > USERNAME_MAX_LENGTH) {
    errors.push(`Username must be at most ${USERNAME_MAX_LENGTH} characters`);
  }

  if (!USERNAME_REGEX.test(username)) {
    errors.push("Username can only contain letters, numbers, underscores, and hyphens");
  }

  return { valid: errors.length === 0, errors };
}

/* ============ ESCROW INPUT VALIDATION ============ */
/**
 * @param {object} input
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateEscrowInput({ amount, item_description, item_type, seller_email }) {
  const errors = [];

  if (!seller_email) {
    errors.push("Seller email is required");
  } else {
    const emailCheck = validateEmail(seller_email);
    if (!emailCheck.valid) errors.push(...emailCheck.errors);
  }

  if (amount === undefined || amount === null) {
    errors.push("Amount is required");
  } else if (typeof amount !== "number" || isNaN(amount)) {
    errors.push("Amount must be a number");
  } else if (amount <= 0) {
    errors.push("Amount must be greater than 0");
  } else if (amount > 21_000_000) {
    errors.push("Amount exceeds maximum allowed");
  }

  if (!item_description || typeof item_description !== "string") {
    errors.push("Item description is required");
  } else if (item_description.length > 2000) {
    errors.push("Item description must be 2000 characters or less");
  } else if (item_description.trim().length < 10) {
    errors.push("Item description must be at least 10 characters");
  }

  if (!item_type) {
    errors.push("Item type is required");
  } else if (!["digital", "physical"].includes(item_type)) {
    errors.push("Item type must be 'digital' or 'physical'");
  }

  return { valid: errors.length === 0, errors };
}

/* ============ DISPUTE INPUT VALIDATION ============ */
const VALID_DISPUTE_REASONS = [
  "Item not received",
  "Item damaged or different",
  "Fraud or scam",
  "Poor quality",
  "Communication issue",
  "Other",
];

/**
 * @param {object} input
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDisputeInput({ escrowId, reason, evidence }) {
  const errors = [];

  if (!escrowId || typeof escrowId !== "string") {
    errors.push("Escrow ID is required");
  }

  if (!reason || typeof reason !== "string") {
    errors.push("Reason is required");
  } else if (!VALID_DISPUTE_REASONS.includes(reason)) {
    errors.push(`Invalid reason. Must be one of: ${VALID_DISPUTE_REASONS.join(", ")}`);
  }

  if (!evidence || typeof evidence !== "string") {
    errors.push("Evidence is required");
  } else if (evidence.trim().length < 10) {
    errors.push("Evidence must be at least 10 characters");
  } else if (evidence.length > 5000) {
    errors.push("Evidence must be 5000 characters or less");
  }

  return { valid: errors.length === 0, errors };
}

/* ============ PAGINATION VALIDATION ============ */
/**
 * Validate and clamp pagination params.
 * @param {object} query  – req.query
 * @returns {{ limit: number, offset: number }}
 */
export function validatePagination(query) {
  let limit = parseInt(query?.limit) || 20;
  let offset = parseInt(query?.offset) || 0;
  limit = Math.min(Math.max(limit, 1), 100); // cap 1–100
  offset = Math.max(offset, 0);
  return { limit, offset };
}

/* ============ STRING SANITISATION ============ */
/**
 * Escape HTML entities to prevent XSS when returning user-generated content.
 * @param {string} str
 * @returns {string}
 */
export function sanitizeString(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}
