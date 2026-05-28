function getConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const isProduction = nodeEnv === "production";
  return {
    nodeEnv,
    isProduction,
    port: Number(process.env.PORT || 3000),
    dailySearchLimit: Number(process.env.DAILY_SEARCH_LIMIT || 5),
    enableExport: process.env.ENABLE_EXPORT !== "false",
    enableDiscovery: process.env.ENABLE_DISCOVERY !== "false",
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX || (isProduction ? 120 : 600)),
    requiredEnv: isProduction ? ["YOUTUBE_API_KEY"] : []
  };
}

function validateConfig() {
  const config = getConfig();
  const missing = config.requiredEnv.filter((key) => !process.env[key]);
  const warnings = [];
  if (!process.env.YOUTUBE_API_KEY) warnings.push("YOUTUBE_API_KEY belum diisi. Riset YouTube akan gagal.");
  if (!String(process.env.MEMBER_API_TOKEN || "").trim() && config.isProduction) warnings.push("MEMBER_API_TOKEN belum diisi. Member mode dinonaktifkan, app tetap berjalan sebagai guest mode.");
  if (process.env.DEV_UNLIMITED === "true" && config.isProduction) warnings.push("DEV_UNLIMITED=true aktif di production. Matikan sebelum deploy publik.");
  return { config, missing, warnings, ok: missing.length === 0 };
}

module.exports = {
  getConfig,
  validateConfig
};
