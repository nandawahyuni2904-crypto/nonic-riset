module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const limit = Number(process.env.DAILY_SEARCH_LIMIT || 5);
  return res.status(200).json({
    mode: "guest",
    used: 0,
    limit,
    remaining: limit,
    memberModeEnabled: Boolean(process.env.MEMBER_API_TOKEN)
  });
};
