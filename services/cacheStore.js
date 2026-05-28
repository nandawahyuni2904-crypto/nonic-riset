const fs = require("node:fs");
const path = require("node:path");
const { trackCacheHit, trackCacheMiss } = require("./quotaMonitor");

const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 30 * 60 * 1000);
const CACHE_FILE = path.join(__dirname, "..", "data", "cache.json");
const memory = new Map();
let loaded = false;

function getCache(key, options = {}) {
  ensureLoaded();
  const entry = memory.get(key);
  if (!entry) {
    trackCacheMiss();
    return null;
  }
  const expired = Date.now() - Number(entry.timestamp || 0) > CACHE_TTL_MS;
  if (expired && !options.allowExpired) {
    trackCacheMiss();
    return null;
  }
  trackCacheHit();
  return {
    ...entry.result,
    fromCache: true,
    cacheExpired: expired,
    cacheTimestamp: entry.timestamp
  };
}

function setCache(key, keyword, result) {
  ensureLoaded();
  const entry = {
    keyword,
    timestamp: Date.now(),
    result: {
      ...result,
      fromCache: false
    }
  };
  memory.set(key, entry);
  persist();
  return entry.result;
}

function clearCache() {
  ensureLoaded();
  memory.clear();
  persist();
}

function getCacheStatus() {
  ensureLoaded();
  const now = Date.now();
  const entries = Array.from(memory.entries()).map(([key, entry]) => ({
    key,
    keyword: entry.keyword,
    timestamp: entry.timestamp,
    ageMs: now - Number(entry.timestamp || 0),
    expired: now - Number(entry.timestamp || 0) > CACHE_TTL_MS
  }));
  return {
    ttlMs: CACHE_TTL_MS,
    count: entries.length,
    activeCount: entries.filter((item) => !item.expired).length,
    expiredCount: entries.filter((item) => item.expired).length,
    entries
  };
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (isReadOnlyRuntime()) return;
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    Object.entries(raw.entries || {}).forEach(([key, entry]) => memory.set(key, entry));
  } catch {
    memory.clear();
  }
}

function persist() {
  if (isReadOnlyRuntime()) return;
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    entries: Object.fromEntries(memory)
  }, null, 2));
}

function isReadOnlyRuntime() {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

function persistCache() {
  ensureLoaded();
  persist();
}

module.exports = {
  CACHE_TTL_MS,
  clearCache,
  getCache,
  getCacheStatus,
  persistCache,
  setCache
};
