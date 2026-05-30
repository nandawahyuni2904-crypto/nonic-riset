const crypto = require("node:crypto");

const AMS_TEST_PATH = "/api/v2/ams/get_open_campaign_added_product";
const REFRESH_PATH = "/api/v2/auth/access_token/get";
const TEST_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
const DEFAULT_AMS_PARAMS = {
  page_no: 1,
  page_size: 10
};

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const partnerId = String(process.env.SHOPEE_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  let tokenInfo = getTokenInfo(req);
  let refreshedCookie = null;
  if (!tokenInfo.accessToken && tokenInfo.source === "cookie" && tokenInfo.refreshToken && tokenInfo.shopId && partnerId && partnerKey) {
    const refreshResult = await refreshCookieAccessToken({
      partnerId,
      partnerKey,
      refreshToken: tokenInfo.refreshToken,
      shopId: tokenInfo.shopId,
      envName: String(process.env.SHOPEE_ENV || "production").trim().toLowerCase() || "production"
    });
    tokenInfo = {
      ...tokenInfo,
      accessToken: refreshResult.accessToken || "",
      refreshToken: refreshResult.refreshToken || tokenInfo.refreshToken,
      shopId: refreshResult.shopId || tokenInfo.shopId,
      source: "cookie",
      refreshAttempted: true,
      refreshSuccess: Boolean(refreshResult.accessToken),
      refreshError: refreshResult.error || null
    };
    refreshedCookie = refreshResult.cookie || null;
  }
  if (refreshedCookie) res.setHeader("Set-Cookie", refreshedCookie);
  const accessToken = tokenInfo.accessToken;
  const shopId = tokenInfo.shopId;
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
  Object.entries(DEFAULT_AMS_PARAMS).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

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
        active_shop_id: shopId || null,
        active_token_source: tokenInfo.source,
        access_token_refresh_attempted: Boolean(tokenInfo.refreshAttempted),
        access_token_refresh_success: Boolean(tokenInfo.refreshSuccess),
        access_token_refresh_error: tokenInfo.refreshError || null,
        params: DEFAULT_AMS_PARAMS,
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
        active_shop_id: shopId || null,
        active_token_source: tokenInfo.source,
        access_token_refresh_attempted: Boolean(tokenInfo.refreshAttempted),
        access_token_refresh_success: Boolean(tokenInfo.refreshSuccess),
        access_token_refresh_error: tokenInfo.refreshError || null,
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

async function refreshCookieAccessToken({ partnerId, partnerKey, refreshToken, shopId, envName }) {
  const numericPartnerId = Number(partnerId);
  const numericShopId = Number(shopId);
  if (!Number.isFinite(numericPartnerId) || !Number.isFinite(numericShopId)) {
    return { error: "Cannot refresh Shopee token because partner_id/shop_id is not numeric." };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${REFRESH_PATH}${timestamp}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = new URL(REFRESH_PATH, resolveBaseUrl(envName));
  url.searchParams.set("partner_id", String(numericPartnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        refresh_token: refreshToken,
        shop_id: numericShopId,
        partner_id: numericPartnerId
      })
    });
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok || !data?.access_token) {
      return {
        error: data?.message || data?.error || `Shopee refresh token failed (${response.status})`
      };
    }
    const expireIn = Number(data.expire_in || data.expires_in || 0) || 14400;
    const nextRefreshToken = data.refresh_token || refreshToken;
    const nextShopId = String(data.shop_id || numericShopId);
    return {
      accessToken: String(data.access_token || ""),
      refreshToken: String(nextRefreshToken || ""),
      shopId: nextShopId,
      cookie: [
        serializeCookie("SHOPEE_ACCESS_TOKEN", data.access_token, expireIn),
        serializeCookie("SHOPEE_REFRESH_TOKEN", nextRefreshToken, 60 * 60 * 24 * 30),
        serializeCookie("SHOPEE_SHOP_ID", nextShopId, 60 * 60 * 24 * 30)
      ]
    };
  } catch (error) {
    return { error: error.message };
  }
}

function getTokenInfo(req) {
  const cookies = parseCookies(req);
  const cookieAccessToken = String(cookies.SHOPEE_ACCESS_TOKEN || "").trim();
  const cookieRefreshToken = String(cookies.SHOPEE_REFRESH_TOKEN || "").trim();
  const cookieShopId = String(cookies.SHOPEE_SHOP_ID || "").trim();
  const envAccessToken = String(process.env.SHOPEE_ACCESS_TOKEN || "").trim();
  const envRefreshToken = String(process.env.SHOPEE_REFRESH_TOKEN || "").trim();
  const envShopId = String(process.env.SHOPEE_SHOP_ID || "").trim();
  const cookieSessionExists = Boolean(cookieAccessToken || cookieRefreshToken || cookieShopId);
  const source = cookieSessionExists ? "cookie" : envAccessToken ? "env" : "none";
  return {
    accessToken: cookieSessionExists ? cookieAccessToken : envAccessToken,
    refreshToken: cookieSessionExists ? cookieRefreshToken : envRefreshToken,
    shopId: cookieSessionExists ? cookieShopId : envShopId,
    source
  };
}

function serializeCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value || "")}; Max-Age=${Math.max(60, Number(maxAge || 0) || 14400)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || "");
  return header.split(";").reduce((acc, item) => {
    const index = item.indexOf("=");
    if (index === -1) return acc;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }
    return acc;
  }, {});
}
