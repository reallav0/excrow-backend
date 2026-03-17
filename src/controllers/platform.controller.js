import express from "express";
import { getDB } from "../config/db.js";

const router = express.Router();

router.get("/status", async (_req, res) => {
  try {
    const db = getDB();
    const settingsDoc = await db.collection("admin_config").findOne({ key: "admin_settings" });
    const settings = settingsDoc?.value || {};

    const payload = {
      maintenanceMode: !!settings.maintenanceMode,
    };

    const message = settings.maintenanceMessage || settings.message;
    if (typeof message === "string" && message.trim()) {
      payload.message = message.trim();
    }

    return res.status(200).json(payload);
  } catch {
    return res.status(200).json({ maintenanceMode: false });
  }
});

export default router;
