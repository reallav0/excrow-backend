/**
 * Normalize IPv4-mapped IPv6 addresses and trim whitespace.
 */
function normalizeIp(rawIp) {
  if (typeof rawIp !== "string") {
    return null;
  }

  const trimmed = rawIp.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice(7);
  }

  return trimmed;
}

/**
 * Read a request header as a string.
 */
function readHeader(req, headerName) {
  const headerValue = req.headers?.[headerName];
  if (Array.isArray(headerValue)) {
    return headerValue[0] || null;
  }
  return typeof headerValue === "string" ? headerValue : null;
}

/**
 * Return the first IP from an X-Forwarded-For chain.
 */
function getFirstForwardedIp(forwardedFor) {
  if (typeof forwardedFor !== "string") {
    return null;
  }

  const first = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .find(Boolean);

  return normalizeIp(first || "");
}

/**
 * Resolve the most reliable client IP from Cloudflare/proxy headers.
 */
export function getClientIp(req) {
  const trustProxyEnabled = req.app?.get ? Boolean(req.app.get("trust proxy")) : true;

  if (trustProxyEnabled) {
    const fromCloudflare = normalizeIp(readHeader(req, "cf-connecting-ip") || "");
    if (fromCloudflare) {
      return fromCloudflare;
    }

    const fromForwardedFor = getFirstForwardedIp(readHeader(req, "x-forwarded-for") || "");
    if (fromForwardedFor) {
      return fromForwardedFor;
    }

    const fromRealIp = normalizeIp(readHeader(req, "x-real-ip") || "");
    if (fromRealIp) {
      return fromRealIp;
    }
  }

  return normalizeIp(req.ip) || normalizeIp(req.socket?.remoteAddress) || "unknown";
}

export default getClientIp;