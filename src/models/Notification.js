import { ObjectId } from "mongodb";
import { getDB } from "../config/db.js";

const COLLECTION = "notifications";

function buildNotificationIdFilter(notificationId) {
  if (typeof notificationId !== "string") {
    return null;
  }

  const normalized = notificationId.trim();
  if (!normalized) {
    return null;
  }

  const orFilters = [{ notificationId: normalized }];
  if (ObjectId.isValid(normalized)) {
    orFilters.push({ _id: new ObjectId(normalized) });
  }

  return { $or: orFilters };
}

function mapNotification(doc) {
  return {
    id: doc?.notificationId || (doc?._id ? String(doc._id) : null),
    type: doc?.type || "info",
    title: doc?.title || "Notification",
    message: doc?.message || "",
    read: !!doc?.read,
    relatedEntity: doc?.relatedEntity || null,
    createdAt: doc?.createdAt || null,
  };
}

export async function listUserNotifications({ userId, read, limit = 50, offset = 0 }) {
  const db = getDB();

  const filter = {
    userId,
    isDeleted: { $ne: true },
  };
  if (typeof read === "boolean") {
    filter.read = read;
  }

  const docs = await db
    .collection(COLLECTION)
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip(offset)
    .limit(limit)
    .toArray();

  return docs.map(mapNotification);
}

export async function markNotificationRead({ userId, notificationId }) {
  const db = getDB();
  const idFilter = buildNotificationIdFilter(notificationId);
  if (!idFilter) {
    return null;
  }

  const result = await db.collection(COLLECTION).findOneAndUpdate(
    {
      userId,
      isDeleted: { $ne: true },
      ...idFilter,
    },
    {
      $set: {
        read: true,
        readAt: new Date(),
        updatedAt: new Date(),
      },
    },
    {
      returnDocument: "after",
    }
  );

  return result?.value ? mapNotification(result.value) : null;
}

export async function markAllNotificationsRead({ userId }) {
  const db = getDB();

  const result = await db.collection(COLLECTION).updateMany(
    {
      userId,
      isDeleted: { $ne: true },
      read: { $ne: true },
    },
    {
      $set: {
        read: true,
        readAt: new Date(),
        updatedAt: new Date(),
      },
    }
  );

  return result?.modifiedCount || 0;
}

export async function softDeleteNotification({ userId, notificationId }) {
  const db = getDB();
  const idFilter = buildNotificationIdFilter(notificationId);
  if (!idFilter) {
    return null;
  }

  const result = await db.collection(COLLECTION).findOneAndUpdate(
    {
      userId,
      isDeleted: { $ne: true },
      ...idFilter,
    },
    {
      $set: {
        isDeleted: true,
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    {
      returnDocument: "after",
    }
  );

  return result?.value ? mapNotification(result.value) : null;
}
