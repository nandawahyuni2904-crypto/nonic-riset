module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const configured = Boolean(process.env.SHOPEE_PARTNER_ID && process.env.SHOPEE_PARTNER_KEY);
  const authorized = Boolean(process.env.SHOPEE_ACCESS_TOKEN && process.env.SHOPEE_SHOP_ID);
  return res.status(200).json({
    configured,
    authorized,
    tokenStatus: authorized ? "active" : "not_authorized",
    shop_id: process.env.SHOPEE_SHOP_ID || null,
    environment: process.env.SHOPEE_ENV || "production"
  });
};
