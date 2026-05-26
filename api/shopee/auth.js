const { buildAuthUrl } = require("../../services/shopeeOpen");

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const data = buildAuthUrl();
    return res.status(200).json({
      authUrl: data.authUrl,
      redirectUrl: data.redirectUrl,
      environment: data.environment,
      redirectParamName: data.redirectParamName
    });
  } catch (error) {
    return res.status(error.code === "SHOPEE_OPEN_NOT_CONFIGURED" ? 400 : 500).json({
      error: error.message
    });
  }
};
