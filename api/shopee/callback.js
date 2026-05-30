const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN_PATH = "/api/v2/auth/token/get";
const TEST_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
const TMP_TOKEN_PATH = path.join("/tmp", "shopee-token.json");

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
      const expireIn = Number(token.expire_in || token.expires_in || 0) || 0;
      const expireAt = expireIn > 0 ? new Date(Date.now() + expireIn * 1000).toISOString() : null;
      const tmpWrite = writeTmpToken({
        access_token: token.access_token,
        refresh_token: token.refresh_token || "",
        shop_id: token.shop_id || numericShopId,
        expire_at: expireAt
      });
      const cookies = buildTokenCookies({
        accessToken: token.access_token,
        refreshToken: token.refresh_token || "",
        shopId: token.shop_id || numericShopId,
        expireIn,
        storageWriteSuccess: tmpWrite.ok
      });
      console.log("[shopee-callback-token-storage]", {
        received_access_token: Boolean(token.access_token),
        received_refresh_token: Boolean(token.refresh_token),
        received_shop_id: Boolean(token.shop_id || numericShopId),
        storage_write_success: tmpWrite.ok,
        tmp_path: TMP_TOKEN_PATH,
        tmp_error: tmpWrite.error || null,
        access_token_length: String(token.access_token || "").length,
        refresh_token_length: String(token.refresh_token || "").length,
        shop_id: token.shop_id || numericShopId
      });
      res.writeHead(302, {
        Location: "/",
        "Set-Cookie": cookies
      });
      return res.end();
    }
    console.warn("[shopee-callback-token-storage-failed]", {
      http_status: response.status,
      received_access_token: Boolean(token?.access_token),
      received_refresh_token: Boolean(token?.refresh_token),
      received_shop_id: Boolean(token?.shop_id || numericShopId),
      response_keys: token && typeof token === "object" ? Object.keys(token) : []
    });
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

function buildTokenCookies(token) {
  const maxAge = Math.max(60, Number(token.expireIn || 0) || 14400);
  const callbackDebug = {
    received_access_token: Boolean(token.accessToken),
    received_refresh_token: Boolean(token.refreshToken),
    received_shop_id: Boolean(token.shopId),
    storage_write_success: Boolean(token.storageWriteSuccess),
    access_token_length: String(token.accessToken || "").length,
    refresh_token_length: String(token.refreshToken || "").length
  };
  const cookies = [
    serializeCookie("SHOPEE_ACCESS_TOKEN", token.accessToken, maxAge),
    serializeCookie("SHOPEE_REFRESH_TOKEN", token.refreshToken || "", 60 * 60 * 24 * 30),
    serializeCookie("SHOPEE_SHOP_ID", String(token.shopId || ""), 60 * 60 * 24 * 30),
    serializeCookie("SHOPEE_CALLBACK_DEBUG", Buffer.from(JSON.stringify(callbackDebug)).toString("base64url"), 60 * 15)
  ];
  return cookies;
}

function writeTmpToken(token) {
  try {
    fs.writeFileSync(TMP_TOKEN_PATH, JSON.stringify(token, null, 2), "utf8");
    return { ok: true };
  } catch (error) {
    console.warn("[shopee-token-tmp-write-failed]", {
      path: TMP_TOKEN_PATH,
      error: error.message
    });
    return { ok: false, error: error.message };
  }
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
