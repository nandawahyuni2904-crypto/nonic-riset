const crypto = require("node:crypto");

const TOKEN_PATH = "/api/v2/auth/token/get";
const TEST_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = req.query || parseQuery(req);
  const code = String(query.code || "").trim();
  const shopId = String(query.shop_id || query.shopid || "").trim();
  const partnerId = String(process.env.SHOPEE_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  const envName = String(process.env.SHOPEE_ENV || "production").trim().toLowerCase() || "production";
  const baseUrl = resolveBaseUrl(envName);

  if (!code || !shopId) {
    return res.status(400).json({
      ok: false,
      error: "Callback Shopee harus membawa code dan shop_id.",
      code: code || null,
      shop_id: shopId || null
    });
  }

  if (!partnerId || !partnerKey) {
    return res.status(400).json({
      ok: false,
      error: "Shopee Open Platform belum dikonfigurasi. Isi SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY."
    });
  }

  const numericShopId = Number(shopId);
  const numericPartnerId = Number(partnerId);
  if (!Number.isFinite(numericShopId) || !Number.isFinite(numericPartnerId)) {
    return res.status(400).json({
      ok: false,
      error: "partner_id dan shop_id harus numerik.",
      partner_id: partnerId,
      shop_id: shopId
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${TOKEN_PATH}${timestamp}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = `${baseUrl}${TOKEN_PATH}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const body = {
    code,
    shop_id: numericShopId,
    partner_id: numericPartnerId
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    const data = parseJson(text);
    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      endpoint: url,
      request: {
        path: TOKEN_PATH,
        partner_id: numericPartnerId,
        shop_id: numericShopId,
        timestamp,
        baseStringLength: baseString.length,
        signLength: sign.length,
        envName,
        baseUrl
      },
      shopee: data ?? text
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: error.message,
      request: {
        path: TOKEN_PATH,
        partner_id: numericPartnerId,
        shop_id: numericShopId,
        timestamp,
        baseStringLength: baseString.length,
        signLength: sign.length,
        envName,
        baseUrl
      }
    });
  }
};

function parseQuery(req) {
  const host = req.headers?.host || "localhost";
  const url = new URL(req.url || "/", `https://${host}`);
  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return query;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveBaseUrl(value) {
  const env = String(value || "").trim().toLowerCase();
  return /^(test|sandbox|testing|dev|development)$/.test(env) ? TEST_BASE_URL : PRODUCTION_BASE_URL;
}
