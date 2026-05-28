module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(200).json({
    youtubeRequestsToday: 0,
    cacheHitRate: 0,
    estimatedQuotaUnitsToday: 0,
    quotaUsagePercent: 0,
    quotaNearLimit: false
  });
};
