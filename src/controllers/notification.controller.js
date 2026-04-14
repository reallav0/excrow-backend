import express from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  softDeleteNotification,
} from "../models/Notification.js";

const router = express.Router();

function parseBooleanQuery(value) {
  if (value === undefined) {
    return { value: undefined };
  }
  if (typeof value === "boolean") {
    return { value };
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1"].includes(normalized)) {
      return { value: true };
    }
    if (["false", "0"].includes(normalized)) {
      return { value: false };
    }
  }
  return { error: "read must be true or false" };
}

function parsePagination(query) {
  const parsedLimit = Number.parseInt(query?.limit, 10);
  const parsedOffset = Number.parseInt(query?.offset, 10);

  const limit = Number.isInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 50;
  const offset = Number.isInteger(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

  return { limit, offset };
}

function getNotificationIdParam(req) {
  const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
  return id;
}

// All notification routes require authentication
router.use(authenticate);

/* ------------------ GET USER NOTIFICATIONS ------------------ */
router.get("/notifications", async (req, res) => {
  try {
    const userId = req.user.userId;
    const readFilter = parseBooleanQuery(req.query.read);
    if (readFilter.error) {
      return res.status(400).json({
        error: "Invalid read query",
        code: "INVALID_READ_FILTER",
        details: readFilter.error,
      });
    }

    const { limit, offset } = parsePagination(req.query);

    const notifications = await listUserNotifications({
      userId,
      read: readFilter.value,
      limit,
      offset,
    });

    return res.status(200).json(notifications);
  } catch (error) {
    console.error("Get Notifications Error:", error);
    return res.status(500).json({
      error: "Server error",
      code: "INTERNAL_SERVER_ERROR",
    });
  }
});

/* ------------------ MARK SINGLE NOTIFICATION AS READ ------------------ */
router.patch("/notifications/:id/read", async (req, res) => {
  try {
    const userId = req.user.userId;
    const notificationId = getNotificationIdParam(req);
    if (!notificationId) {
      return res.status(400).json({
        error: "Invalid notification ID",
        code: "INVALID_NOTIFICATION_ID",
      });
    }

    const updated = await markNotificationRead({ userId, notificationId });
    if (!updated) {
      return res.status(404).json({
        error: "Notification not found",
        code: "NOTIFICATION_NOT_FOUND",
      });
    }

    return res.status(200).json({
      id: updated.id,
      read: true,
      message: "Notification marked as read",
    });
  } catch (error) {
    console.error("Mark Notification Read Error:", error);
    return res.status(500).json({
      error: "Server error",
      code: "INTERNAL_SERVER_ERROR",
    });
  }
});

/* ------------------ MARK ALL NOTIFICATIONS AS READ ------------------ */
router.patch("/notifications/read-all", async (req, res) => {
  try {
    const userId = req.user.userId;
    const count = await markAllNotificationsRead({ userId });

    return res.status(200).json({
      message: "All notifications marked as read",
      count,
    });
  } catch (error) {
    console.error("Mark All Notifications Read Error:", error);
    return res.status(500).json({
      error: "Server error",
      code: "INTERNAL_SERVER_ERROR",
    });
  }
});

/* ------------------ SOFT DELETE NOTIFICATION ------------------ */
router.delete("/notifications/:id", async (req, res) => {
  try {
    const userId = req.user.userId;
    const notificationId = getNotificationIdParam(req);
    if (!notificationId) {
      return res.status(400).json({
        error: "Invalid notification ID",
        code: "INVALID_NOTIFICATION_ID",
      });
    }

    const deleted = await softDeleteNotification({ userId, notificationId });
    if (!deleted) {
      return res.status(404).json({
        error: "Notification not found",
        code: "NOTIFICATION_NOT_FOUND",
      });
    }

    return res.status(200).json({
      id: deleted.id,
      message: "Notification deleted",
    });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    return res.status(500).json({
      error: "Server error",
      code: "INTERNAL_SERVER_ERROR",
    });
  }
});

export default router;
