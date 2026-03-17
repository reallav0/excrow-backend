import { WebSocketServer } from "ws";
import { ADMIN_SESSION_COOKIE_NAME, authenticateAdminToken } from "../middleware/adminAuth.middleware.js";

const MAX_FEED_ITEMS = 200;
const feedItems = [];

let liveFeedWss = null;

function normalizeFeedItem(item) {
  return {
    type: item?.type || "activity",
    text: item?.text || "Admin activity",
    ts: item?.ts || new Date().toISOString(),
  };
}

function extractCookieValue(cookieHeader, key) {
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === key) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

function addToFeed(item) {
  const normalized = normalizeFeedItem(item);
  feedItems.unshift(normalized);
  if (feedItems.length > MAX_FEED_ITEMS) {
    feedItems.length = MAX_FEED_ITEMS;
  }
  return normalized;
}

export function publishAdminLiveFeed(item) {
  const payload = addToFeed(item);

  if (!liveFeedWss) return payload;

  const serialized = JSON.stringify(payload);
  for (const client of liveFeedWss.clients) {
    if (client.readyState === 1) {
      client.send(serialized);
    }
  }

  return payload;
}

export function getAdminLiveFeedItems(limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  return feedItems.slice(0, safeLimit);
}

export function setupAdminLiveFeedWs(httpServer) {
  liveFeedWss = new WebSocketServer({ noServer: true });

  liveFeedWss.on("connection", (ws, _req, admin) => {
    ws.send(
      JSON.stringify({
        type: "system",
        text: `Live feed connected for ${admin.username}`,
      })
    );
  });

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      const requestUrl = new URL(request.url, "http://localhost");
      pathname = requestUrl.pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== "/admin/ws/live-feed" && pathname !== "/api/admin/ws/live-feed") {
      return;
    }

    const token = extractCookieValue(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME);
    const auth = authenticateAdminToken(token);
    if (!auth.ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    liveFeedWss.handleUpgrade(request, socket, head, (ws) => {
      liveFeedWss.emit("connection", ws, request, auth.admin);
    });
  });
}
