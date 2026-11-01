import { Router } from "express";
import { getDB } from "../config/db.js";

/**
 * Liveness / readiness probes.
 *
 * These routes are mounted before the request logger and before any
 * authentication or rate limiting, and GET /health does no I/O at all.
 * That makes /health the correct endpoint for measuring the maximum
 * throughput of the HTTP stack itself (Node + Express + socket handling).
 *
 * /ready is the DB-aware probe: it pings MongoDB on every call and is the
 * endpoint to use when you want a number that includes the database.
 */

const router = Router();

const PROCESS_ID = process.pid;

/**
 * Liveness probe: pure in-process response, no DB, no disk, no auth.
 * The payload is hand-built to keep the hot path allocation-light.
 */
router.get("/health", (_req, res) => {
  const body = `{"status":"ok","pid":${PROCESS_ID},"uptime":${process
    .uptime()
    .toFixed(2)},"time":${Date.now()}}`;

  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("Cache-Control", "no-store");
  return res.status(200).send(body);
});

/**
 * Readiness probe: verifies the MongoDB connection with a ping.
 * Returns 503 when the database is unreachable.
 */
router.get("/ready", async (_req, res) => {
  const startedAt = process.hrtime.bigint();

  try {
    await getDB().command({ ping: 1 });
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return res.status(200).json({
      status: "ready",
      db: "up",
      dbLatencyMs: Number(durationMs.toFixed(2)),
    });
  } catch {
    return res.status(503).json({ status: "unavailable", db: "down" });
  }
});

// Convenience aliases used by common orchestrators.
router.get("/healthz", (_req, res) => res.redirect(307, "/health"));
router.get("/livez", (_req, res) => res.redirect(307, "/health"));
router.get("/readyz", (_req, res) => res.redirect(307, "/ready"));

export default router;
