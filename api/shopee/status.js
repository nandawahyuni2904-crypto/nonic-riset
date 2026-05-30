const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AMS_PATH = "/api/v2/ams/get_open_campaign_added_product";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
const TMP_TOKEN_PATH = path.join("/tmp", "shopee-token.json");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const environment = String(process.env.SHOPEE_ENV || "production").trim().toLowerCase() || "production";
  const partnerId = String(process.env.SHOPEE_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  const tokenInfo = getTokenInfo(req);
  const accessToken = tokenInfo.accessToken;
  const shopId = tokenInfo.shopId;
  const tokenExpiresAt = tokenInfo.expiresAt;

  const liveMode = !/^(test|sandbox|testing|dev|development)$/.test(environment);
  const tokenExists = Boolean(accessToken);
  const tokenExpired = isTokenExpired(tokenExpiresAt);
  const authCompleted = Boolean(tokenExists && shopId && !tokenExpired);

  const result = {
    environment,
    partner_id: partnerId || null,
    live_mode: liveMode,
    token_exists: tokenExists,
    token_expired: tokenExpired,
    auth_completed: authCompleted,
    token_source: tokenInfo.source,
    api_reachable: false,
    recommendation_api_status: "not_checked",
    error: null
  };

  const missing = [];
  if (!partnerId) missing.push("SHOPEE_PARTNER_ID");
  if (!partnerKey) missing.push("SHOPEE_PARTNER_KEY");
  if (!shopId) missing.push("SHOPEE_SHOP_ID");
  if (!accessToken) missing.push("SHOPEE_ACCESS_TOKEN");

  if (!liveMode) {
    result.recommendation_api_status = "not_live_mode";
    result.error = "SHOPEE_ENV bukan production. Set SHOPEE_ENV=production untuk AMS live.";
    return res.status(200).json(result);
  }

  if (missing.length) {
    result.recommendation_api_status = "missing_env";
    result.error = `Token belum tersedia di /tmp atau ENV belum lengkap: ${missing.join(", ")}. Login ulang lewat /api/shopee/auth.`;
    return res.status(200).json(result);
  }

  const numericPartnerId = Number(partnerId);
  const numericShopId = Number(shopId);
  if (!Number.isFinite(numericPartnerId) || !Number.isFinite(numericShopId)) {
    result.recommendation_api_status = "invalid_env";
    result.error = "SHOPEE_PARTNER_ID dan SHOPEE_SHOP_ID harus numerik.";
    return res.status(200).json(result);
  }

  if (tokenExpired) {
    result.recommendation_api_status = "token_expired";
    result.error = "Shopee access token expired. Re-authorize seller lalu update SHOPEE_ACCESS_TOKEN.";
    return res.status(200).json(result);
  }

  try {
    const { url, debug } = buildSignedAmsUrl({
      partnerId,
      partnerKey,
      accessToken,
      shopId
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const text = await response.text();
    const data = parseJson(text);
    const shopeeError = extractShopeeError(data, text);
    result.api_reachable = true;
    result.recommendation_api_status = classifyAmsResponse(response.status, data, shopeeError);
    result.error = shopeeError || (!response.ok ? `Shopee AMS HTTP ${response.status}` : null);

    console.log("[shopee-status-debug]", {
      path: AMS_PATH,
      status: response.status,
      recommendation_api_status: result.recommendation_api_status,
      partner_id: numericPartnerId,
      shop_id: numericShopId,
      baseStringLength: debug.baseStringLength,
      signLength: debug.signLength
    });
    return res.status(200).json(result);
  } catch (error) {
    result.api_reachable = false;
    result.recommendation_api_status = "request_failed";
    result.error = error.name === "AbortError"
      ? "Shopee AMS request timeout."
      : error.message;
    return res.status(200).json(result);
  }
};

function buildSignedAmsUrl({ partnerId, partnerKey, accessToken, shopId }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${AMS_PATH}${timestamp}${accessToken}${shopId}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = new URL(AMS_PATH, PRODUCTION_BASE_URL);
  url.searchParams.set("partner_id", String(Number(partnerId)));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("shop_id", String(Number(shopId)));
  url.searchParams.set("sign", sign);
  return {
    url: url.toString(),
    debug: {
      baseStringLength: baseString.length,
      signLength: sign.length
    }
  };
}

function isTokenExpired(value) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time <= Date.now() : false;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getTokenInfo(req) {
  const tmpToken = readTmpToken();
  const cookies = parseCookies(req);
  const envAccessToken = String(process.env.SHOPEE_ACCESS_TOKEN || "").trim();
  const tmpAccessToken = String(tmpToken?.access_token || "").trim();
  const cookieAccessToken = String(cookies.SHOPEE_ACCESS_TOKEN || "").trim();
  const source = tmpAccessToken ? "tmp" : cookieAccessToken ? "cookie" : envAccessToken ? "env" : "none";
  return {
    accessToken: tmpAccessToken || cookieAccessToken || envAccessToken,
    refreshToken: String(tmpAccessToken ? tmpToken?.refresh_token : cookieAccessToken ? cookies.SHOPEE_REFRESH_TOKEN : process.env.SHOPEE_REFRESH_TOKEN || "").trim(),
    shopId: String(tmpAccessToken ? tmpToken?.shop_id : cookieAccessToken ? cookies.SHOPEE_SHOP_ID : process.env.SHOPEE_SHOP_ID || "").trim(),
    expiresAt: String(tmpAccessToken ? tmpToken?.expire_at : process.env.SHOPEE_TOKEN_EXPIRES_AT || process.env.SHOPEE_ACCESS_TOKEN_EXPIRES_AT || "").trim(),
    source
  };
}

function readTmpToken() {
  try {
    if (!fs.existsSync(TMP_TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TMP_TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
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

function extractShopeeError(data, text) {
  if (data && typeof data === "object") {
    return data.message || data.error || data.msg || data.detail || null;
  }
  return text && !/^\s*\{/.test(text) ? String(text).slice(0, 300) : null;
}

function classifyAmsResponse(status, data, error) {
  const text = `${error || ""} ${JSON.stringify(data || {})}`.toLowerCase();
  if (/permission|forbidden|unauthorized|no auth|access denied|not allowed/.test(text)) return "permission_denied";
  if (/invalid access_token|token|expired/.test(text)) return "token_invalid_or_expired";
  if (/invalid partner|wrong sign|sign/.test(text)) return "sign_or_partner_error";
  if (/ams|affiliate/.test(text) && /not|no|empty|permission|access/.test(text)) return "ams_not_available";
  if (status >= 200 && status < 300) {
    const rawItems = data?.response?.item_list || data?.response?.items || data?.response?.product_list || data?.item_list || data?.items || [];
    return Array.isArray(rawItems) && rawItems.length ? "ok_with_items" : "ok_empty";
  }
  if (status >= 500) return "shopee_server_error";
  return `http_${status}`;
}
