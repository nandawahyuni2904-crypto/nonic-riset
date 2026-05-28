const crypto = require("node:crypto");

const AMS_TEST_PATH = "/api/v2/ams/get_open_campaign_added_product";
const TEST_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const partnerId = String(process.env.SHOPEE_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  const accessToken = String(process.env.SHOPEE_ACCESS_TOKEN || "").trim();
  const shopId = String(process.env.SHOPEE_SHOP_ID || "").trim();
  const envName = String(process.env.SHOPEE_ENV || "production").trim().toLowerCase() || "production";
  const baseUrl = resolveBaseUrl(envName);

  const missing = [];
  if (!partnerId) missing.push("SHOPEE_PARTNER_ID");
  if (!partnerKey) missing.push("SHOPEE_PARTNER_KEY");
  if (!accessToken) missing.push("SHOPEE_ACCESS_TOKEN");
  if (!shopId) missing.push("SHOPEE_SHOP_ID");
  if (missing.length) {
    return res.status(400).json({
      ok: false,
      error: "ENV Shopee AMS test belum lengkap.",
      missing
    });
  }

  const numericPartnerId = Number(partnerId);
  const numericShopId = Number(shopId);
  if (!Number.isFinite(numericPartnerId) || !Number.isFinite(numericShopId)) {
    return res.status(400).json({
      ok: false,
      error: "SHOPEE_PARTNER_ID dan SHOPEE_SHOP_ID harus numerik.",
      partner_id: partnerId,
      shop_id: shopId
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${AMS_TEST_PATH}${timestamp}${accessToken}${shopId}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = new URL(AMS_TEST_PATH, baseUrl);
  url.searchParams.set("partner_id", String(numericPartnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("shop_id", String(numericShopId));
  url.searchParams.set("sign", sign);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    });
    const text = await response.text();
    const data = parseJson(text);
    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      request: {
        path: AMS_TEST_PATH,
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
        path: AMS_TEST_PATH,
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
