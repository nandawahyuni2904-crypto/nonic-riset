const DAY_MS = 24 * 60 * 60 * 1000;
let state = {
  day: dayKey(),
  youtubeRequests: 0,
  cacheHits: 0,
  cacheMisses: 0
};

function trackYouTubeRequest(count = 1) {
  resetIfNeeded();
  state.youtubeRequests += count;
}

function trackCacheHit() {
  resetIfNeeded();
  state.cacheHits += 1;
}

function trackCacheMiss() {
  resetIfNeeded();
  state.cacheMisses += 1;
}

function getQuotaStatus() {
  resetIfNeeded();
  const totalCache = state.cacheHits + state.cacheMisses;
  const dailyLimit = Number(process.env.YOUTUBE_DAILY_QUOTA_UNITS || 10000);
  const estimated = state.youtubeRequests * 100;
  const usagePercent = dailyLimit ? Math.round((estimated / dailyLimit) * 100) : 0;
  return {
    day: state.day,
    youtubeRequestsToday: state.youtubeRequests,
    estimatedQuotaUnitsToday: estimated,
    dailyQuotaUnits: dailyLimit,
    quotaUsagePercent: usagePercent,
    quotaNearLimit: usagePercent >= Number(process.env.QUOTA_SLOWDOWN_PERCENT || 80),
    cacheHits: state.cacheHits,
    cacheMisses: state.cacheMisses,
    cacheHitRate: totalCache ? Math.round((state.cacheHits / totalCache) * 100) : 0,
    resetInMs: nextResetMs()
  };
}

function shouldSlowDownRequests() {
  return getQuotaStatus().quotaNearLimit;
}

function resetIfNeeded() {
  const current = dayKey();
  if (state.day !== current) {
    state = { day: current, youtubeRequests: 0, cacheHits: 0, cacheMisses: 0 };
  }
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nextResetMs() {
  const now = Date.now();
  const next = new Date(new Date().toISOString().slice(0, 10)).getTime() + DAY_MS;
  return Math.max(0, next - now);
}

module.exports = {
  getQuotaStatus,
  shouldSlowDownRequests,
  trackCacheHit,
  trackCacheMiss,
  trackYouTubeRequest
};
