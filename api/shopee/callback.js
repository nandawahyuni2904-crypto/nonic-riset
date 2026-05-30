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
    const token = data && typeof data === "object" ? data : null;
    if (response.ok && token?.access_token) {
      setTokenCookies(res, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token || "",
        shopId: token.shop_id || numericShopId,
        expireIn: token.expire_in || token.expires_in || 0
      });
    }
    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      token_storage: response.ok && token?.access_token ? "secure_http_only_cookie" : "not_saved",
      note: response.ok && token?.access_token
        ? "Token disimpan sebagai secure HttpOnly cookie untuk request browser ini. Vercel serverless tidak bisa menulis ENV permanen dari runtime."
        : "Token tidak disimpan karena Shopee tidak mengembalikan access_token.",
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
      shopee: sanitizeTokenResponse(data ?? text)
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

function setTokenCookies(res, token) {
  const maxAge = Math.max(60, Number(token.expireIn || 0) || 14400);
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  const cookies = [
    serializeCookie("shopee_access_token", token.accessToken, maxAge),
    serializeCookie("shopee_refresh_token", token.refreshToken || "", 60 * 60 * 24 * 30),
    serializeCookie("shopee_shop_id", String(token.shopId || ""), 60 * 60 * 24 * 30),
    serializeCookie("shopee_token_expires_at", expiresAt, maxAge)
  ];
  res.setHeader("Set-Cookie", cookies);
}

function serializeCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value || "")}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function sanitizeTokenResponse(value) {
  if (!value || typeof value !== "object") return value;
  const clone = { ...value };
  if (clone.access_token) clone.access_token = `REDACTED:${String(clone.access_token).length}`;
  if (clone.refresh_token) clone.refresh_token = `REDACTED:${String(clone.refresh_token).length}`;
  return clone;
}
