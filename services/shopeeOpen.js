const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { opportunityLabel } = require("./scoring");
const { shopeeApiLog } = require("./logger");

const DATA_DIR = path.join(__dirname, "..", "data");
const TOKEN_FILE = path.join(DATA_DIR, "shopee-token.json");
const DEFAULT_BASE_URL = "https://partner.shopeemobile.com";
const DEFAULT_SANDBOX_BASE_URL = "https://partner.test-stable.shopeemobile.com";
const PRODUCTION_AUTH_BASE_URL = "https://partner.shopeemobile.com";
const AUTH_PATH = "/api/v2/shop/auth_partner";
const TOKEN_PATH = "/api/v2/auth/token/get";
const REFRESH_PATH = "/api/v2/auth/access_token/get";
const AMS_PATH = "/api/v2/ams/get_product_performance";
const SHOP_INFO_PATH = "/api/v2/shop/get_shop_info";
const DEFAULT_AMS_PARAMS = {
  period_type: "Last30d",
  order_type: "ConfirmedOrder",
  channel: "AllChannel",
  page_no: 1,
  page_size: 10
};

function getConfig() {
  const partnerId = String(process.env.SHOPEE_PARTNER_ID || process.env.SHOPEE_TEST_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || process.env.SHOPEE_TEST_PARTNER_KEY || "").trim();
  const environment = normalizeEnvironment(process.env.SHOPEE_ENV || process.env.SHOPEE_OPEN_ENV || "");
  const defaultBaseUrl = environment === "sandbox" ? DEFAULT_SANDBOX_BASE_URL : DEFAULT_BASE_URL;
  const baseUrl = String(process.env.SHOPEE_OPEN_BASE_URL || process.env.SHOPEE_BASE_URL || defaultBaseUrl).trim();
  const defaultAuthBaseUrl = environment === "sandbox"
    ? DEFAULT_SANDBOX_BASE_URL
    : PRODUCTION_AUTH_BASE_URL;
  const authBaseUrl = String(
    process.env.SHOPEE_AUTH_BASE_URL
    || process.env.SHOPEE_OPEN_AUTH_BASE_URL
    || defaultAuthBaseUrl
  ).trim();
  return {
    partnerId,
    partnerKey,
    shopId: Number(String(process.env.SHOPEE_SHOP_ID || "0").trim()),
    environment,
    baseUrl,
    authBaseUrl,
    redirectUrl: String(
      process.env.SHOPEE_REDIRECT
      || process.env.SHOPEE_REDIRECT_URL
      || "https://nonic-riset.vercel.app/api/shopee/callback"
    ).trim(),
    region: String(process.env.SHOPEE_SHOP_REGION || "ID").trim().toUpperCase()
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.partnerId && config.partnerKey);
}

function assertConfigured() {
  if (!isConfigured()) {
    const error = new Error("Shopee Open Platform belum dikonfigurasi. Isi SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY di .env.");
    error.code = "SHOPEE_OPEN_NOT_CONFIGURED";
    throw error;
  }
}

function sign(pathname, timestamp, accessToken = "", shopId = "") {
  const config = getConfig();
  const baseString = `${config.partnerId}${pathname}${timestamp}${accessToken || ""}${shopId || ""}`;
  return crypto.createHmac("sha256", config.partnerKey).update(baseString).digest("hex");
}

function signAuthPartner({ partnerId, partnerKey, timestamp }) {
  const cleanPartnerId = String(partnerId || "").trim();
  const cleanPartnerKey = String(partnerKey || "").trim();
  const cleanTimestamp = String(timestamp || "").trim();
  const baseString = `${cleanPartnerId}${AUTH_PATH}${cleanTimestamp}`;
  const signature = crypto.createHmac("sha256", cleanPartnerKey).update(baseString).digest("hex");
  return { baseString, sign: signature };
}

function getDebugSign() {
  assertConfigured();
  const config = getConfig();
  const timestamp = getUnixTimestampSeconds();
  const now = new Date();
  const nowMs = now.getTime();
  const { baseString, sign: signature } = signAuthPartner({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    timestamp
  });
  const authUrl = buildAuthUrlWithTimestamp(timestamp).authUrl;
  return {
    authUrl,
    path: AUTH_PATH,
    nowIso: now.toISOString(),
    dateNowMs: nowMs,
    newDateGetTimeMs: nowMs,
    timestamp,
    timestampFormula: "Math.floor(new Date().getTime() / 1000)",
    expectedCurrentRange: "harus mendekati waktu sekarang",
    partnerId: config.partnerId,
    partnerKeyLength: config.partnerKey.length,
    baseString,
    sign: signature,
    signLength: signature.length,
    redirectParamName: "redirect",
    redirectUrl: config.redirectUrl,
    authBaseUrl: config.authBaseUrl,
    apiBaseUrl: config.baseUrl,
    environment: config.environment,
    partnerIdConfigured: Boolean(config.partnerId),
  };
}

function buildAuthUrl() {
  assertConfigured();
  return buildAuthUrlWithTimestamp(getUnixTimestampSeconds());
}

function buildAuthUrlWithTimestamp(timestamp) {
  const config = getConfig();
  const url = new URL(AUTH_PATH, config.authBaseUrl);
  url.searchParams.set("partner_id", config.partnerId);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", signAuthPartner({
    partnerId: config.partnerId,
    partnerKey: config.partnerKey,
    timestamp
  }).sign);
  url.searchParams.set("redirect", config.redirectUrl);
  return {
    authUrl: url.toString(),
    productionFormat: `${PRODUCTION_AUTH_BASE_URL}${AUTH_PATH}?partner_id=...&timestamp=...&sign=...&redirect=...`,
    path: AUTH_PATH,
    baseUrl: config.authBaseUrl,
    apiBaseUrl: config.baseUrl,
    redirectUrl: config.redirectUrl,
    redirectParamName: "redirect",
    environment: config.environment,
    sandbox: config.environment === "sandbox"
  };
}

async function exchangeCodeForToken({ code, shopId }) {
  assertConfigured();
  const parsed = validateCallbackParams({ code, shopId });
  if (!parsed.valid) {
    const error = new Error(parsed.message);
    error.code = parsed.code;
    error.debug = sanitizeCallbackValidation(parsed);
    throw error;
  }
  code = parsed.codeValue;
  shopId = parsed.shopIdValue;
  if (!code) {
    const error = new Error("Code authorization Shopee tidak ditemukan.");
    error.code = "SHOPEE_CODE_MISSING";
    throw error;
  }
  const config = getConfig();
  const resolvedShopId = Number(shopId || config.shopId || 0);
  shopeeApiLog("token_exchange_request", {
    path: TOKEN_PATH,
    shopId: resolvedShopId,
    environment: config.environment,
    codeLength: code.length
  });
  const data = await signedAuthPost(TOKEN_PATH, {
    code,
    shop_id: resolvedShopId || undefined,
    partner_id: normalizePartnerId(config.partnerId)
  });
  const token = await saveToken({
    ...data,
    shop_id: Number(data.shop_id || resolvedShopId || config.shopId || 0),
    authorized_at: new Date().toISOString()
  });
  shopeeApiLog("token_exchange_success", {
    shopId: token.shop_id,
    expiresAt: token.expires_at,
    hasRefreshToken: Boolean(token.refresh_token)
  });
  return token;
}

function parseCallbackQuery(searchParams) {
  const raw = {};
  for (const [key, value] of searchParams.entries()) raw[key] = value;
  const codeValue = String(searchParams.get("code") || "").trim();
  const shopIdValue = String(searchParams.get("shop_id") || searchParams.get("shopid") || "").trim();
  const validation = sanitizeCallbackValidation(validateCallbackParams({ code: codeValue, shopId: shopIdValue }));
  const debug = {
    receivedAt: new Date().toISOString(),
    fullCallbackQuery: redactSensitiveQuery(raw),
    queryKeys: Object.keys(raw),
    parsed: {
      code: redactPotentialSecret(codeValue),
      codeLength: codeValue.length,
      shop_id: redactPotentialSecret(shopIdValue),
      shopIdIsNumeric: /^\d+$/.test(shopIdValue)
    },
    validation,
    expected: {
      code: "Auth code dari Shopee, biasanya string alphanumeric.",
      shop_id: "Numeric Shopee shop_id, contoh 123456789.",
      authUrlPath: AUTH_PATH,
      productionAuthorizeHost: PRODUCTION_AUTH_BASE_URL,
      redirectParamName: "redirect"
    }
  };
  shopeeApiLog("callback_debug", debug);
  return debug;
}

async function refreshTokenIfAvailable() {
  assertConfigured();
  const current = await readToken();
  if (!current?.refresh_token) {
    const error = new Error("Refresh token Shopee belum tersedia.");
    error.code = "SHOPEE_REFRESH_TOKEN_MISSING";
    throw error;
  }
  const config = getConfig();
  shopeeApiLog("token_refresh_request", {
    path: REFRESH_PATH,
    shopId: Number(current.shop_id || config.shopId || 0),
    environment: config.environment
  });
  const data = await signedAuthPost(REFRESH_PATH, {
    refresh_token: current.refresh_token,
    shop_id: Number(current.shop_id || config.shopId || 0),
    partner_id: normalizePartnerId(config.partnerId)
  });
  const token = await saveToken({
    ...current,
    ...data,
    shop_id: Number(data.shop_id || current.shop_id || config.shopId || 0),
    refreshed_at: new Date().toISOString()
  });
  shopeeApiLog("token_refresh_success", {
    shopId: token.shop_id,
    expiresAt: token.expires_at,
    hasRefreshToken: Boolean(token.refresh_token)
  });
  return token;
}

async function getAmsProductPerformance(options = {}) {
  assertConfigured();
  const token = await getAuthorizedToken();
  const params = normalizeAmsParams(options);
  const request = buildSignedGetRequest(AMS_PATH, params, token);
  shopeeApiLog("ams_product_performance_request", {
    shopId: Number(token.shop_id || getConfig().shopId || 0) || null,
    params,
    environment: getConfig().environment
  });
  const response = await fetch(request.url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || isErrorMessage(data.message)) {
    const error = new Error(data.message || data.error || `Shopee AMS request gagal (${response.status}).`);
    error.status = response.status;
    error.response = data;
    error.requestUrl = redactToken(request.url);
    shopeeApiLog("ams_product_performance_error", {
      status: response.status,
      error: error.message,
      response: data?.error || data?.message || ""
    });
    throw error;
  }
  const rawItems = extractItems(data);
  const items = rawItems.map(normalizePerformanceItem).filter(Boolean);
  const reason = diagnoseAmsResponse(data, rawItems, items);
  return {
    platform: "shopee-open-ams",
    environment: getConfig().environment,
    sandbox: getConfig().environment === "sandbox",
    authorized: true,
    request: params,
    count: items.length,
    rawItemCount: rawItems.length,
    mappedItemCount: items.length,
    message: reason,
    items,
    raw: process.env.SHOPEE_AMS_INCLUDE_RAW === "true" ? data : undefined
  };
}

async function debugAmsProductPerformance(options = {}) {
  const status = await getStatus();
  const params = normalizeAmsParams(options);
  if (!status.configured || !status.authorized) {
    return {
      authorized: status.authorized,
      tokenStatus: status.tokenStatus,
      shop_id: status.shop_id,
      endpointUsed: AMS_PATH,
      requestParams: params,
      rawShopeeError: status.configured ? status.tokenStatus : "Shopee Open Platform belum dikonfigurasi.",
      rawShopeeMessage: status.configured ? "Shopee belum authorized." : "Isi Shopee ENV terlebih dahulu.",
      rawItemCount: 0,
      mappedItemCount: 0,
      debugReason: status.configured ? "Shopee belum authorized." : "Shopee Open Platform belum dikonfigurasi."
    };
  }

  try {
    const data = await getAmsProductPerformance(params);
    return {
      authorized: true,
      tokenStatus: "active",
      shop_id: status.shop_id,
      endpointUsed: AMS_PATH,
      requestParams: data.request,
      rawShopeeError: "",
      rawShopeeMessage: data.message || "",
      rawItemCount: data.rawItemCount || 0,
      mappedItemCount: data.mappedItemCount || 0,
      debugReason: data.message || "",
      sampleItems: (data.items || []).slice(0, 3).map((item) => ({
        item_id: item.item_id,
        item_name: item.item_name,
        items_sold: item.items_sold,
        orders: item.orders,
        clicks: item.clicks,
        roi: item.roi
      }))
    };
  } catch (error) {
    const detail = sanitizeShopeeDebugResponse(error.response || {});
    return {
      authorized: status.authorized,
      tokenStatus: status.tokenStatus,
      shop_id: status.shop_id,
      endpointUsed: AMS_PATH,
      requestParams: params,
      rawShopeeError: detail.error || error.code || "",
      rawShopeeMessage: detail.message || error.message || "",
      rawItemCount: 0,
      mappedItemCount: 0,
      debugReason: diagnoseAmsError(error),
      status: error.status || undefined
    };
  }
}

async function getStatus() {
  let token = await readToken();
  if (token?.access_token && token?.refresh_token && token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
    try {
      token = await refreshTokenIfAvailable();
    } catch (error) {
      shopeeApiLog("status_refresh_skipped", {
        error: error.message,
        code: error.code || ""
      });
    }
  }
  const config = getConfig();
  const expired = Boolean(token?.expires_at && new Date(token.expires_at).getTime() <= Date.now());
  const expiresInSeconds = token?.expires_at ? Math.max(0, Math.round((new Date(token.expires_at).getTime() - Date.now()) / 1000)) : null;
  const authorized = Boolean(token?.access_token && !expired);
  return {
    configured: isConfigured(),
    authorized,
    environment: config.environment,
    sandbox: config.environment === "sandbox",
    baseUrl: config.baseUrl,
    redirectUrl: config.redirectUrl,
    shop_id: token?.shop_id || config.shopId || null,
    connectedShops: token?.shop_id || config.shopId ? [{
      shop_id: token?.shop_id || config.shopId,
      region: config.region,
      environment: config.environment,
      tokenStatus: authorized ? "active" : token?.access_token ? "expired" : "not_authorized",
      expiresAt: token?.expires_at || null,
      expiresInSeconds
    }] : [],
    tokenStatus: authorized ? "active" : token?.access_token ? "expired" : "not_authorized",
    tokenExpired: expired,
    expiresInSeconds,
    shopRegion: config.region,
    hasRefreshToken: Boolean(token?.refresh_token),
    tokenFile: TOKEN_FILE,
    authorizedAt: token?.authorized_at || null,
    refreshedAt: token?.refreshed_at || null,
    expiresAt: token?.expires_at || null
  };
}

async function getShopInfo() {
  assertConfigured();
  const token = await getAuthorizedToken();
  const request = buildSignedGetRequest(SHOP_INFO_PATH, {}, token);
  shopeeApiLog("shop_info_request", {
    shopId: Number(token.shop_id || getConfig().shopId || 0) || null,
    environment: getConfig().environment
  });
  const response = await fetch(request.url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || isErrorMessage(data.message)) {
    const error = new Error(data.message || data.error || `Shopee shop info request gagal (${response.status}).`);
    error.status = response.status;
    error.response = data;
    error.requestUrl = redactToken(request.url);
    shopeeApiLog("shop_info_error", {
      status: response.status,
      error: error.message,
      response: data?.error || data?.message || ""
    });
    throw error;
  }
  const responseData = data.response || data;
  return {
    ok: true,
    environment: getConfig().environment,
    shop_id: token.shop_id || getConfig().shopId || null,
    shop_name: responseData.shop_name || responseData.name || "",
    region: responseData.region || responseData.shop_region || getConfig().region,
    status: responseData.status || responseData.shop_status || "",
    raw: process.env.SHOPEE_ME_INCLUDE_RAW === "true" ? responseData : undefined
  };
}

async function getAuthorizedToken() {
  const token = await readToken();
  if (!token?.access_token) {
    const error = new Error("Shopee belum authorized. Buka /api/shopee/auth-url");
    error.code = "SHOPEE_NOT_AUTHORIZED";
    throw error;
  }
  if (token.expires_at && new Date(token.expires_at).getTime() <= Date.now()) {
    if (token.refresh_token) return refreshTokenIfAvailable();
    const error = new Error("Token Shopee expired. Buka /api/shopee/reconnect-url untuk authorize ulang.");
    error.code = "SHOPEE_TOKEN_EXPIRED";
    throw error;
  }
  return token;
}

async function signedAuthPost(pathname, body) {
  const config = getConfig();
  const timestamp = getUnixTimestampSeconds();
  const url = new URL(pathname, config.baseUrl);
  url.searchParams.set("partner_id", String(config.partnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign(pathname, timestamp));
  shopeeApiLog("auth_post_request", {
    path: pathname,
    shopId: body?.shop_id || null,
    environment: config.environment
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || isErrorMessage(data.message)) {
    const error = new Error(data.message || data.error || `Shopee auth request gagal (${response.status}).`);
    error.status = response.status;
    error.response = data;
    error.requestUrl = redactToken(url.toString());
    shopeeApiLog("auth_post_error", {
      path: pathname,
      status: response.status,
      error: error.message,
      response: data?.error || data?.message || ""
    });
    throw error;
  }
  return data.response || data;
}

function buildSignedGetRequest(pathname, params, token) {
  const config = getConfig();
  const timestamp = getUnixTimestampSeconds();
  const shopId = Number(token.shop_id || config.shopId || 0);
  const accessToken = token.access_token;
  const url = new URL(pathname, config.baseUrl);
  url.searchParams.set("partner_id", String(config.partnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("access_token", accessToken);
  if (shopId) url.searchParams.set("shop_id", String(shopId));
  url.searchParams.set("sign", sign(pathname, timestamp, accessToken, shopId || ""));
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return { url: url.toString(), timestamp };
}

async function readToken() {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function saveToken(token) {
  const normalized = normalizeToken(token);
  if (!normalized.access_token) {
    const error = new Error("Shopee token exchange tidak mengembalikan access_token.");
    error.code = "SHOPEE_ACCESS_TOKEN_MISSING";
    error.response = stripTokenFields(token);
    throw error;
  }
  if (isReadOnlyRuntime()) {
    shopeeApiLog("token_save_skipped_readonly_runtime", {
      shopId: normalized.shop_id,
      expiresAt: normalized.expires_at
    });
    return normalized;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return normalized;
}

function isReadOnlyRuntime() {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

function normalizeToken(token) {
  const expireIn = Number(token.expire_in || token.expires_in || 0);
  const issuedAt = new Date().getTime();
  return {
    access_token: token.access_token || "",
    refresh_token: token.refresh_token || "",
    shop_id: Number(token.shop_id || getConfig().shopId || 0),
    expire_in: expireIn || undefined,
    expires_at: expireIn ? new Date(issuedAt + expireIn * 1000).toISOString() : token.expires_at || null,
    merchant_id: token.merchant_id || token.main_account_id || undefined,
    authorized_at: token.authorized_at,
    refreshed_at: token.refreshed_at
  };
}

function normalizePartnerId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? Number(text) : text;
}

function normalizeAmsParams(options = {}) {
  return {
    period_type: String(options.period_type || DEFAULT_AMS_PARAMS.period_type),
    order_type: String(options.order_type || DEFAULT_AMS_PARAMS.order_type),
    channel: String(options.channel || DEFAULT_AMS_PARAMS.channel),
    page_no: clamp(Number(options.page_no || DEFAULT_AMS_PARAMS.page_no), 1, 1000),
    page_size: clamp(Number(options.page_size || DEFAULT_AMS_PARAMS.page_size), 1, 100)
  };
}

function extractItems(data) {
  const candidates = [
    data?.response?.items,
    data?.response?.item_list,
    data?.response?.product_performance_list,
    data?.response?.list,
    data?.data?.items,
    data?.data?.item_list,
    data?.items,
    data?.item_list
  ];
  return candidates.find(Array.isArray) || [];
}

function diagnoseAmsResponse(data, rawItems, items) {
  const message = String(data?.message || data?.response?.message || data?.data?.message || "").trim();
  if (items.length) return "";
  if (rawItems.length && !items.length) return "Shopee mengembalikan data, tetapi belum bisa dipetakan ke format trends.";
  if (/permission|forbidden|no auth|unauthorized/i.test(message)) return "Permission AMS belum aktif";
  if (/ams|affiliate/i.test(message)) return "AMS belum tersedia untuk toko ini";
  return "Belum ada data affiliate performance";
}

function diagnoseAmsError(error) {
  const text = `${error.message || ""} ${JSON.stringify(error.response || {})}`;
  if (/permission|forbidden|no auth|unauthorized|access/i.test(text)) return "Permission AMS belum aktif";
  if (/ams|affiliate/i.test(text)) return "AMS belum tersedia untuk toko ini";
  return "Belum ada data affiliate performance";
}

function sanitizeShopeeDebugResponse(value) {
  if (!value || typeof value !== "object") return {};
  return {
    error: value.error || value.error_msg || "",
    message: value.message || value.msg || value.error_message || "",
    request_id: value.request_id || value.requestId || ""
  };
}

function normalizePerformanceItem(item) {
  const itemId = item.item_id || item.itemid || item.product_id;
  const itemName = cleanText(item.item_name || item.name || item.product_name);
  if (!itemId && !itemName) return null;
  const itemsSold = toNumber(item.items_sold || item.item_sold || item.sold);
  const orders = toNumber(item.orders || item.order_count);
  const clicks = toNumber(item.clicks || item.click_count);
  const roi = toNumber(item.roi);
  const newBuyers = toNumber(item.new_buyers);
  const chance = scoreAmsPerformance({ itemsSold, orders, clicks, roi, newBuyers });
  return {
    item_id: itemId,
    item_name: itemName,
    sales: toNumber(item.sales),
    items_sold: itemsSold,
    orders,
    clicks,
    est_commission: toNumber(item.est_commission || item.estimated_commission),
    roi,
    total_buyers: toNumber(item.total_buyers || item.buyers),
    new_buyers: newBuyers,
    name: itemName,
    score: chance,
    chance,
    label: opportunityLabel(chance),
    image: item.image || item.image_url || "",
    url: item.product_link || item.item_url || ""
  };
}

function scoreAmsPerformance({ itemsSold, orders, clicks, roi, newBuyers }) {
  const soldScore = normalizeLog(itemsSold, 5) * 35;
  const orderScore = normalizeLog(orders, 4) * 25;
  const clickScore = normalizeLog(clicks, 5) * 15;
  const roiScore = Math.min(1, Math.max(0, Number(roi || 0) / 10)) * 15;
  const buyerScore = normalizeLog(newBuyers, 4) * 10;
  return Math.max(0, Math.min(100, Math.round(soldScore + orderScore + clickScore + roiScore + buyerScore)));
}

function normalizeLog(value, maxLog) {
  return Math.min(1, Math.log10(Math.max(Number(value || 0), 1)) / maxLog);
}

function getUnixTimestampSeconds() {
  const timestamp = Math.floor(new Date().getTime() / 1000);
  return timestamp;
}

function isErrorMessage(message) {
  return typeof message === "string" && /\berror\b|invalid|failed/i.test(message);
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const number = Number(String(value || "0").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function redactToken(url) {
  return String(url).replace(/access_token=[^&]+/g, "access_token=REDACTED").replace(/sign=[^&]+/g, "sign=REDACTED");
}

function validateCallbackParams({ code, shopId }) {
  const codeValue = String(code || "").trim();
  const shopIdValue = String(shopId || "").trim();
  if (!codeValue) {
    return { valid: false, code: "SHOPEE_CODE_MISSING", message: "Callback Shopee tidak membawa parameter code.", codeValue, shopIdValue };
  }
  if (!shopIdValue) {
    return { valid: false, code: "SHOPEE_SHOP_ID_MISSING", message: "Callback Shopee tidak membawa parameter shop_id.", codeValue, shopIdValue };
  }
  if (!/^\d+$/.test(shopIdValue)) {
    return {
      valid: false,
      code: "SHOPEE_SHOP_ID_INVALID",
      message: "shop_id dari callback Shopee harus numerik. Nilai yang diterima terlihat bukan shop_id valid.",
      codeValue,
      shopIdValue
    };
  }
  if (/^shpk/i.test(codeValue)) {
    return {
      valid: false,
      code: "SHOPEE_CODE_INVALID",
      message: "Parameter code terlihat seperti partner key/token, bukan auth code Shopee.",
      codeValue,
      shopIdValue
    };
  }
  return { valid: true, code: "OK", message: "Callback parameter valid.", codeValue, shopIdValue };
}

function sanitizeCallbackValidation(validation) {
  return {
    valid: validation.valid,
    code: validation.code,
    message: validation.message,
    codeLength: String(validation.codeValue || "").length,
    shopIdValue: redactPotentialSecret(validation.shopIdValue),
    shopIdIsNumeric: /^\d+$/.test(String(validation.shopIdValue || "")),
    codePreview: redactPotentialSecret(validation.codeValue)
  };
}

function redactSensitiveQuery(query) {
  return Object.fromEntries(Object.entries(query).map(([key, value]) => [key, redactPotentialSecret(value)]));
}

function stripTokenFields(value) {
  if (!value || typeof value !== "object") return value;
  const clone = { ...value };
  ["access_token", "refresh_token"].forEach((key) => {
    if (clone[key]) clone[key] = "REDACTED";
  });
  return clone;
}

function redactPotentialSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/^shpk/i.test(text) || text.length > 40) return `${text.slice(0, 6)}...REDACTED`;
  return text;
}

function isSandboxBaseUrl(value) {
  return /test-stable|sandbox/i.test(String(value || ""));
}

function normalizeEnvironment(value) {
  const clean = String(value || "").trim().toLowerCase();
  return /^(sandbox|test|testing|development|dev)$/.test(clean) ? "sandbox" : "production";
}

module.exports = {
  AMS_PATH,
  DEFAULT_AMS_PARAMS,
  TOKEN_FILE,
  buildAuthUrl,
  exchangeCodeForToken,
  getAmsProductPerformance,
  debugAmsProductPerformance,
  getConfig,
  getDebugSign,
  getShopInfo,
  getStatus,
  isConfigured,
  parseCallbackQuery,
  refreshTokenIfAvailable,
  sign,
  signAuthPartner
};
