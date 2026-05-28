const crypto = require("node:crypto");

const AUTH_PATH = "/api/v2/shop/auth_partner";
const TEST_BASE_URL = "https://partner.test-stable.shopeemobile.com";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  req.query = req.query || parseQuery(req);
  const partnerId = String(process.env.SHOPEE_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  const redirectUrl = String(process.env.SHOPEE_REDIRECT || "").trim();

  if (!partnerId || !partnerKey) {
    return res.status(400).json({
      error: "Shopee Open Platform belum dikonfigurasi. Isi SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY."
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const path = AUTH_PATH;
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const envName = String(process.env.SHOPEE_ENV || "production").trim().toLowerCase() || "production";
  const baseUrl = resolveBaseUrl(envName);
  console.log("[shopee-auth-debug]", {
    partner_id: partnerId,
    path,
    timestamp,
    baseStringLength: baseString.length,
    signLength: sign.length,
    environment: envName
  });

  if (req.query.debug === "1") {
    return res.status(200).json({
      partnerId,
      partnerIdType: typeof partnerId,
      path,
      timestamp,
      baseString,
      baseStringLength: baseString.length,
      redirectUrl,
      sign,
      signLength: sign.length,
      envName,
      baseUrl
    });
  }

  const authUrl = `${baseUrl}${AUTH_PATH}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectUrl)}`;

  return res.redirect(302, authUrl);
};

function parseQuery(req) {
  const host = req.headers?.host || "localhost";
  const url = new URL(req.url || "/", `https://${host}`);
  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return query;
}

function resolveBaseUrl(value) {
  const env = String(value || "").trim().toLowerCase();
  return /^(test|sandbox|testing|dev|development)$/.test(env) ? TEST_BASE_URL : PRODUCTION_BASE_URL;
}
