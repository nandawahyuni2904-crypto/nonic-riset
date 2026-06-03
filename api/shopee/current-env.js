const ENV_NAMES = [
  "SHOPEE_PARTNER_ID",
  "SHOPEE_PARTNER_KEY",
  "SHOPEE_ENV",
  "PARTNER_ID",
  "PARTNER_KEY",
  "SHOPEE_AFFILIATE_APP_ID",
  "SHOPEE_AFFILIATE_SECRET",
  "SHOPEE_APP_ID",
  "SHOPEE_APP_SECRET"
];

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const status = ENV_NAMES.reduce((acc, name) => {
    acc[name] = Boolean(String(process.env[name] || "").trim());
    return acc;
  }, {});

  return res.status(200).json(status);
};
