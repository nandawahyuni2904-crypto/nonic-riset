const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { createAdvancedApiHandler } = require("./routes/api");
const { labelScore } = require("./services/scoring");
const { createResearchJobService } = require("./services/researchJobs");
const { isShopeeAmsConfigured } = require("./services/shopeeAms");
const { getStatus: getShopeeOpenStatus } = require("./services/shopeeOpen");
const { isDevelopmentUnlimited } = require("./services/usageLimiter");
const { getUsageStatus } = require("./services/usageLimiter");
const { getQuotaStatus, trackYouTubeRequest } = require("./services/quotaMonitor");
const { getCacheStatus, persistCache } = require("./services/cacheStore");
const { getSearchAnalytics } = require("./services/searchAnalytics");
const { getConfig, validateConfig } = require("./services/config");
const { ensureStorage } = require("./services/storageInit");
const { cleanupRateLimit, rateLimit } = require("./services/rateLimiter");
const { errorLog, quotaWarn, requestLog, startupWarn } = require("./services/logger");

loadEnv();
ensureStorage();
const validation = validateConfig();
validation.warnings.forEach(startupWarn);
validation.missing.forEach((key) => startupWarn(`Missing required production ENV: ${key}`));

const APP_CONFIG = getConfig();
const PORT = APP_CONFIG.port;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const TREND_CACHE_TTL_MS = 10 * 60 * 1000;
const trendCache = new Map();

const researchJobService = createResearchJobService({ fetchYouTubeTrends });
const handleAdvancedApi = createAdvancedApiHandler({
  fetchYouTubeTrends,
  researchJobService
});

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  let statusCode = 200;
  try {
    applySecurityHeaders(res);
    const limited = rateLimit(req, { windowMs: APP_CONFIG.rateLimitWindowMs, max: APP_CONFIG.rateLimitMax });
    if (!limited.allowed) {
      statusCode = 429;
      sendJson(res, { error: "Too many requests.", retryAfter: limited.retryAfter }, 429);
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    sanitizeUrl(url);

    if (url.pathname === "/api/trends") {
      await handleTrends(url, res);
      return;
    }

    if (url.pathname === "/api/health") {
      statusCode = 200;
      sendJson(res, await buildHealth(req));
      return;
    }

    if (url.pathname === "/admin") {
      sendAdminDashboard(res);
      return;
    }

    if (url.pathname === "/api/status") {
      sendJson(res, {
        youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY),
        shortsConfigured: Boolean(process.env.YOUTUBE_API_KEY),
        shopeeConfigured: isShopeeAmsConfigured(),
        exportEnabled: process.env.ENABLE_EXPORT !== "false",
        discoveryEnabled: process.env.ENABLE_DISCOVERY !== "false",
        dailySearchLimit: Number(process.env.DAILY_SEARCH_LIMIT || 5),
        devMode: isDevelopmentUnlimited(req)
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const handled = await handleAdvancedApi(
        url,
        (data, status) => {
          statusCode = status || 200;
          return sendJson(res, data, status);
        },
        req,
        (text, status, contentType) => {
          statusCode = status || 200;
          return sendText(res, text, status, contentType);
        },
        (location, status = 302) => {
          statusCode = status;
          return sendRedirect(res, location, status);
        }
      );
      if (handled !== false) return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    statusCode = 500;
    errorLog(error, `${req.method} ${req.url}`);
    sendJson(res, { error: error.message || "Unexpected error" }, 500);
  } finally {
    requestLog(req, res.statusCode || statusCode || 200, Date.now() - startedAt);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Product Trend Finder running at http://localhost:${PORT} (${APP_CONFIG.nodeEnv})`);
  });
  startMaintenanceJobs();
  registerShutdownHandlers();
}

async function handleTrends(url, res) {
  const niche = cleanText(url.searchParams.get("niche") || "");
  const platform = url.searchParams.get("platform") || "youtube";
  const days = clamp(Number(url.searchParams.get("days") || 14), 1, 90);
  const limit = clamp(Number(url.searchParams.get("limit") || 12), 1, 25);

  if (!niche) {
    sendJson(res, { error: "Niche or keyword is required." }, 400);
    return;
  }

  if (platform === "youtube") {
    const cacheKey = `youtube:${niche}:${days}:${Math.min(limit, 10)}`;
    sendJson(res, await cachedTrend(cacheKey, () => fetchYouTubeTrends({ niche, days, limit: Math.min(limit, 10) }), 5));
    return;
  }

  sendJson(res, { error: "Unsupported platform." }, 400);
}

async function fetchYouTubeTrends({ niche, days, limit, shorts = false, regionCode = "ID" }) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    const error = new Error("YouTube API key belum dikonfigurasi");
    error.code = "YOUTUBE_API_KEY_MISSING";
    throw error;
  }

  const maxResults = shorts ? 25 : limit;
  const publishedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  const searchParams = new URLSearchParams({
    key,
    part: "snippet",
    type: "video",
    q: shorts ? niche : `${niche} review OR find OR haul OR product`,
    order: shorts ? (niche ? "relevance" : "viewCount") : "viewCount",
    regionCode,
    relevanceLanguage: "id",
    hl: "id",
    maxResults: String(maxResults),
    publishedAfter
  });
  searchUrl.search = searchParams;
  console.log(`[youtube] search keyword="${niche}" order=${searchParams.get("order")} max=${maxResults}`);

  trackYouTubeRequest(1);
  const searchData = await fetchJson(searchUrl);
  const ids = (searchData.items || []).map((item) => item.id && item.id.videoId).filter(Boolean);
  console.log(`[youtube] raw search results keyword="${niche}" count=${ids.length}`);
  if (ids.length === 0) {
    return { platform: "youtube", configured: true, items: [] };
  }

  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.search = new URLSearchParams({
    key,
    part: "snippet,statistics,contentDetails",
    hl: "id",
    id: ids.join(",")
  });

  trackYouTubeRequest(1);
  const videoData = await fetchJson(videosUrl);
  const normalizedItems = (videoData.items || []).map(normalizeYouTubeVideo);
  const rawItems = normalizedItems.filter((item) => !shorts || isValidShortsItem(item));
  const fallbackItems = shorts && rawItems.length < Math.min(10, normalizedItems.length)
    ? normalizedItems
      .filter((item) => !isRejectedTitle(item.title))
      .sort((a, b) => b.views - a.views)
      .slice(0, Math.min(10, normalizedItems.length))
    : rawItems;
  const items = normalizeViralScores(rawItems)
    .sort((a, b) => b.viral_score - a.viral_score || new Date(b.publishedAt) - new Date(a.publishedAt));
  const finalItems = items.length >= Math.min(10, fallbackItems.length) ? items : normalizeViralScores(dedupeVideos(items.concat(fallbackItems)))
    .sort((a, b) => b.viral_score - a.viral_score || b.views - a.views);
  console.log(`[youtube] final results keyword="${niche}" raw=${normalizedItems.length} filtered=${rawItems.length} final=${finalItems.length}`);

  return {
    platform: "youtube",
    configured: true,
    query: niche,
    since: publishedAfter,
    debug: {
      rawCount: normalizedItems.length,
      filteredCount: rawItems.length,
      finalCount: finalItems.length,
      usedRawFallback: !items.length && fallbackItems.length > 0
    },
    items: finalItems
  };
}

function normalizeYouTubeVideo(item) {
  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  const views = Number(stats.viewCount || 0);
  const likes = Number(stats.likeCount || 0);
  const comments = Number(stats.commentCount || 0);
  const publishedAt = snippet.publishedAt || new Date().toISOString();
  const ageHours = Math.max(1, (Date.now() - new Date(publishedAt).getTime()) / 36e5);
  const velocity = views / ageHours;
  const engagementRate = views ? (likes + comments * 2) / views : 0;
  const score = Math.round(velocity * (1 + engagementRate * 25));
  const durationSeconds = parseDurationSeconds(item.contentDetails?.duration || "");
  const isShort = durationSeconds > 0 && durationSeconds < 90;
  const url = isShort ? `https://www.youtube.com/shorts/${item.id}` : `https://www.youtube.com/watch?v=${item.id}`;
  const viralRaw = views * 0.5 + likes * 0.3 + comments * 0.2;

  return {
    id: item.id,
    title: snippet.title || "Untitled video",
    channel: snippet.channelTitle || "Unknown channel",
    publishedAt,
    uploadDate: publishedAt,
    url,
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
    views,
    likes,
    comments,
    durationSeconds,
    isShort,
    velocity: Math.round(velocity),
    engagementRate,
    viralRaw,
    viral_score: 0,
    score,
    label: labelScore(score)
  };
}

function isValidShortsItem(item) {
  const title = cleanText(item.title).toLowerCase();
  if (!item.url.includes("/shorts/")) return false;
  if (!(item.durationSeconds > 0 && item.durationSeconds < 90)) return false;
  return !isRejectedTitle(title);
}

function isRejectedTitle(title) {
  return /(back to home|trends overview|tiktok creative center|template|login|\bads\b|dashboard)/i.test(cleanText(title));
}

function normalizeViralScores(items) {
  const max = Math.max(...items.map((item) => item.viralRaw || 0), 1);
  return items.map((item) => ({
    ...item,
    viral_score: Math.round(((item.viralRaw || 0) / max) * 100),
    score: Math.round(((item.viralRaw || 0) / max) * 100),
    label: labelScore(Math.round(((item.viralRaw || 0) / max) * 100))
  }));
}

function dedupeVideos(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDurationSeconds(duration) {
  const match = String(duration || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function fetchJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    const wrapped = new Error(`YouTube API request gagal: ${error.message}`);
    wrapped.cause = error;
    wrapped.requestUrl = redactApiKey(String(url));
    throw wrapped;
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `YouTube API request gagal (${response.status})`);
    error.status = response.status;
    error.response = data;
    error.requestUrl = redactApiKey(String(url));
    if (/quotaExceeded|dailyLimitExceeded|quota/i.test(JSON.stringify(data))) {
      error.code = "YOUTUBE_QUOTA_EXCEEDED";
      error.message = "Quota YouTube API habis, ganti API key atau tunggu reset.";
    }
    throw error;
  }
  return data;
}

function redactApiKey(url) {
  return url.replace(/key=([^&]+)/, "key=REDACTED");
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendText(res, "Not found", 404);
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

function sendJson(res, data, status = 200) {
  res.statusCode = status;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, text, status = 200, contentType = "text/plain; charset=utf-8") {
  res.statusCode = status;
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function sendRedirect(res, location, status = 302) {
  res.statusCode = status;
  res.writeHead(status, { Location: location });
  res.end();
}

async function buildHealth(req) {
  const quota = getQuotaStatus();
  if (quota.quotaNearLimit) quotaWarn("YouTube quota nearing limit", quota);
  return {
    ok: validation.ok,
    environment: APP_CONFIG.nodeEnv,
    uptime: process.uptime(),
    uptimeSeconds: Math.round(process.uptime()),
    youtube: {
      configured: Boolean(process.env.YOUTUBE_API_KEY),
      status: process.env.YOUTUBE_API_KEY ? "ready" : "missing_env"
    },
    cache: compactCacheStatus(),
    quota,
    shopee: await getShopeeOpenStatus().catch((error) => ({ configured: false, authorized: false, error: error.message })),
    usage: getUsageStatus(req),
    warnings: validation.warnings,
    missingEnv: validation.missing
  };
}

function compactCacheStatus() {
  const cache = getCacheStatus();
  return {
    ttlMs: cache.ttlMs,
    count: cache.count,
    activeCount: cache.activeCount,
    expiredCount: cache.expiredCount
  };
}

function sendAdminDashboard(res) {
  const analytics = getSearchAnalytics();
  const quota = getQuotaStatus();
  const cache = compactCacheStatus();
  const topKeyword = analytics.mostSearchedKeyword?.key || "-";
  const topNiche = analytics.bestPerformingNiche?.key || "-";
  const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Dashboard</title><link rel="stylesheet" href="/styles.css"></head>
<body><main class="shell"><header class="app-header"><div class="hero-copy"><p class="eyebrow">Admin</p><h1>System Dashboard</h1><p class="lead">Monitoring ringan untuk VPS murah dan long-running server.</p></div></header>
<section class="kpi-grid">
<article class="kpi-card"><span>Daily searches</span><strong>${analytics.totals.events}</strong><p>events tracked</p></article>
<article class="kpi-card"><span>Top keyword</span><strong>${escapeHtml(topKeyword)}</strong><p>most searched</p></article>
<article class="kpi-card"><span>Quota usage</span><strong>${quota.quotaUsagePercent}%</strong><p>${quota.estimatedQuotaUnitsToday}/${quota.dailyQuotaUnits} units</p></article>
<article class="kpi-card"><span>Cache hit ratio</span><strong>${quota.cacheHitRate}%</strong><p>${cache.activeCount} active cache</p></article>
<article class="kpi-card"><span>Top niche</span><strong>${escapeHtml(topNiche)}</strong><p>best performing</p></article>
</section></main></body></html>`;
  sendText(res, html, 200, "text/html; charset=utf-8");
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' https://i.ytimg.com https://*.ytimg.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none';");
}

function sanitizeUrl(url) {
  for (const [key, value] of url.searchParams.entries()) {
    const clean = sanitizeInput(value);
    if (clean !== value) url.searchParams.set(key, clean);
  }
}

function sanitizeInput(value) {
  return String(value || "").replace(/[<>`]/g, "").replace(/[\u0000-\u001f]/g, "").slice(0, 500);
}

function startMaintenanceJobs() {
  setInterval(() => {
    persistCache();
    cleanupRateLimit();
  }, 5 * 60 * 1000).unref();
}

function registerShutdownHandlers() {
  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal} received. Saving cache...`);
    try {
      persistCache();
    } catch (error) {
      errorLog(error, "shutdown persistCache");
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    errorLog(error, "uncaughtException");
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (error) => {
    errorLog(error, "unhandledRejection");
  });
}

function cleanText(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 120);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function cachedTrend(key, producer, minItems = 0) {
  const existing = trendCache.get(key);
  if (existing && Date.now() - existing.createdAt < TREND_CACHE_TTL_MS && (existing.data.items || []).length >= minItems) {
    return { ...existing.data, cached: true };
  }
  const data = await producer();
  trendCache.set(key, { createdAt: Date.now(), data });
  return data;
}

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;
    const key = trimmed.slice(0, equalIndex).trim();
    const value = trimmed.slice(equalIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = value;
  }
}

module.exports = {
  fetchYouTubeTrends
};
