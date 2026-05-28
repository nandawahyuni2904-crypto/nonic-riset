const { JsonStore } = require("./jsonStore");

const store = new JsonStore("usage.json", { days: {} });

function getUserContext(req) {
  const token = getHeader(req, "x-member-token");
  const expected = getMemberApiToken();
  const isMember = Boolean(expected && token && token === expected);
  const isDevUnlimited = isDevelopmentUnlimited(req);
  return {
    mode: isDevUnlimited ? "dev" : isMember ? "member" : "guest",
    key: isDevUnlimited ? "dev:local" : isMember ? `member:${token.slice(0, 8)}` : `guest:${getClientId(req)}`,
    devUnlimited: isDevUnlimited
  };
}

function assertUsageAllowed(req) {
  const context = getUserContext(req);
  if (context.devUnlimited) return { allowed: true, ...context, remaining: "unlimited" };
  if (context.mode === "member") return { allowed: true, ...context, remaining: "unlimited" };
  const limit = Number(process.env.DAILY_SEARCH_LIMIT || 5);
  const day = dayKey();
  const usage = store.read();
  const current = Number(usage.days?.[day]?.[context.key] || 0);
  if (current >= limit) {
    const error = new Error(`Guest limit tercapai (${limit} search/hari). Gunakan member mode untuk unlimited.`);
    error.code = "USAGE_LIMIT_REACHED";
    error.status = 429;
    error.limit = limit;
    error.used = current;
    throw error;
  }
  return { allowed: true, ...context, remaining: Math.max(0, limit - current) };
}

function recordSearch(req) {
  const context = getUserContext(req);
  if (context.devUnlimited) return { ...context, used: "unlimited", remaining: "unlimited" };
  if (context.mode === "member") return { ...context, used: "unlimited", remaining: "unlimited" };
  const limit = Number(process.env.DAILY_SEARCH_LIMIT || 5);
  const day = dayKey();
  return store.update((usage) => {
    usage.days = usage.days || {};
    usage.days[day] = usage.days[day] || {};
    usage.days[day][context.key] = Number(usage.days[day][context.key] || 0) + 1;
    return usage;
  }).days[day][context.key] && {
    ...context,
    used: store.read().days[day][context.key],
    remaining: Math.max(0, limit - store.read().days[day][context.key])
  };
}

function getUsageStatus(req) {
  const context = getUserContext(req);
  if (context.devUnlimited) return { mode: "dev", used: 0, limit: "unlimited", remaining: "unlimited", devUnlimited: true };
  if (context.mode === "member") return { mode: "member", used: 0, limit: "unlimited", remaining: "unlimited", memberModeEnabled: true };
  const limit = Number(process.env.DAILY_SEARCH_LIMIT || 5);
  const used = Number(store.read().days?.[dayKey()]?.[context.key] || 0);
  return { mode: "guest", used, limit, remaining: Math.max(0, limit - used), memberModeEnabled: Boolean(getMemberApiToken()) };
}

function getClientId(req) {
  return String(getHeader(req, "x-client-id") || getHeader(req, "x-forwarded-for") || req?.socket?.remoteAddress || "local").split(",")[0].trim();
}

function isDevelopmentUnlimited(req) {
  const enabled = process.env.DEV_UNLIMITED === "true" || process.env.NODE_ENV === "development";
  if (!enabled) return false;
  return isLocalRequest(req);
}

function isLocalRequest(req) {
  const host = String(getHeader(req, "host") || "");
  const remote = String(req?.socket?.remoteAddress || "");
  return /localhost|127\.0\.0\.1|\[::1\]|::1/i.test(host) || /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/.test(remote);
}

function getHeader(req, name) {
  const headers = req?.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || "").trim();
}

function getMemberApiToken() {
  return String(process.env.MEMBER_API_TOKEN || "").trim();
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  assertUsageAllowed,
  getUsageStatus,
  getUserContext,
  isDevelopmentUnlimited,
  recordSearch
};
