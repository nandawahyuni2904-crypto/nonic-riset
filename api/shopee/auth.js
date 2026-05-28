const crypto = require("node:crypto");

const AUTH_PATH = "/api/v2/shop/auth_partner";
const TEST_BASE_URL = "https://partner.test-stable.shopeemobile.com";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
const DEFAULT_REDIRECT_URL = "https://nonic-riset.vercel.app/api/shopee/callback";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const partnerId = String(process.env.SHOPEE_PARTNER_ID || process.env.SHOPEE_TEST_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || process.env.SHOPEE_TEST_PARTNER_KEY || "").trim();
  const redirectUrl = String(process.env.SHOPEE_REDIRECT || process.env.SHOPEE_REDIRECT_URL || DEFAULT_REDIRECT_URL).trim();

  if (!partnerId || !partnerKey) {
    return res.status(400).json({
      error: "Shopee Open Platform belum dikonfigurasi. Isi SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY."
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${AUTH_PATH}${timestamp}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const baseUrl = resolveBaseUrl(process.env.SHOPEE_ENV);
  const authUrl = `${baseUrl}${AUTH_PATH}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUrl)}`;

  return res.redirect(302, authUrl);
};

function resolveBaseUrl(value) {
  const env = String(value || "").trim().toLowerCase();
  return /^(test|sandbox|testing|dev|development)$/.test(env) ? TEST_BASE_URL : PRODUCTION_BASE_URL;
}
