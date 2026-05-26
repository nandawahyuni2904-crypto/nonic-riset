const buckets = new Map();

function rateLimit(req, { windowMs, max }) {
  const key = clientKey(req);
  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count > max) {
    return {
      allowed: false,
      retryAfter: Math.ceil((bucket.resetAt - now) / 1000),
      limit: max
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, max - bucket.count),
    resetAt: bucket.resetAt
  };
}

function cleanupRateLimit() {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "local").split(",")[0].trim();
}

module.exports = {
  cleanupRateLimit,
  rateLimit
};
