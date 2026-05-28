module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({
    youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    shortsConfigured: Boolean(process.env.YOUTUBE_API_KEY),
    shopeeConfigured: Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY),
    exportEnabled: process.env.ENABLE_EXPORT !== "false",
    discoveryEnabled: process.env.ENABLE_DISCOVERY !== "false",
    dailySearchLimit: Number(process.env.DAILY_SEARCH_LIMIT || 5),
    devMode: false
  });
};
