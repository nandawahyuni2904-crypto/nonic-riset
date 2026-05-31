const crypto = require("node:crypto");

const AMS_PATH = "/api/v2/ams/get_open_campaign_added_product";
const REFRESH_PATH = "/api/v2/auth/access_token/get";
const TEST_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
const DEFAULT_AMS_PARAMS = {
  page_no: 1,
  page_size: 10
};

async function getAmsProductsFromRequest(req, options = {}) {
  const partnerId = String(process.env.SHOPEE_PARTNER_ID || "").trim();
  const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || "").trim();
  const environment = String(process.env.SHOPEE_ENV || "production").trim().toLowerCase() || "production";
  const params = {
    ...DEFAULT_AMS_PARAMS,
    ...options
  };

  if (!partnerId || !partnerKey) {
    return {
      ok: false,
      items: [],
      error: "Shopee Open Platform belum dikonfigurasi.",
      status: "not_configured"
    };
  }

  let tokenInfo = getTokenInfo(req);
  let setCookies = null;
  if (!tokenInfo.accessToken && tokenInfo.source === "cookie" && tokenInfo.refreshToken && tokenInfo.shopId) {
    const refreshResult = await refreshCookieAccessToken({
      partnerId,
      partnerKey,
      refreshToken: tokenInfo.refreshToken,
      shopId: tokenInfo.shopId,
      environment
    });
    tokenInfo = {
      ...tokenInfo,
      accessToken: refreshResult.accessToken || "",
      refreshToken: refreshResult.refreshToken || tokenInfo.refreshToken,
      shopId: refreshResult.shopId || tokenInfo.shopId,
      expiresAt: refreshResult.expiresAt || "",
      source: "cookie",
      refreshAttempted: true,
      refreshSuccess: Boolean(refreshResult.accessToken),
      refreshError: refreshResult.error || null
    };
    setCookies = refreshResult.cookie || null;
  }

  if (!tokenInfo.accessToken || !tokenInfo.shopId) {
    return {
      ok: false,
      items: [],
      error: tokenInfo.source === "cookie" ? "Token Shopee cookie belum lengkap." : "Token Shopee belum tersedia.",
      status: "missing_token",
      tokenSource: tokenInfo.source,
      shopId: tokenInfo.shopId || null,
      setCookies
    };
  }

  const request = buildSignedAmsUrl({
    partnerId,
    partnerKey,
    accessToken: tokenInfo.accessToken,
    shopId: tokenInfo.shopId,
    environment,
    params
  });

  try {
    const response = await fetch(request.url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    const text = await response.text();
    const data = parseJson(text);
    if (!response.ok || data?.error) {
      return {
        ok: false,
        items: [],
        error: data?.message || data?.error || `Shopee AMS request gagal (${response.status}).`,
        status: "ams_error",
        tokenSource: tokenInfo.source,
        shopId: tokenInfo.shopId,
        responseStatus: response.status,
        raw: data ?? text,
        setCookies
      };
    }

    const rawItems = extractItems(data);
    const items = rawItems.map(normalizeAmsProduct).filter(Boolean);
    return {
      ok: true,
      items,
      rawItemCount: rawItems.length,
      mappedItemCount: items.length,
      tokenSource: tokenInfo.source,
      shopId: tokenInfo.shopId,
      stats: buildAmsStats(items),
      setCookies,
      message: items.length ? "Shopee Ready" : "Shopee Ready, belum ada produk AMS pada periode ini."
    };
  } catch (error) {
    return {
      ok: false,
      items: [],
      error: error.message,
      status: "request_failed",
      tokenSource: tokenInfo.source,
      shopId: tokenInfo.shopId,
      setCookies
    };
  }
}

function buildSignedAmsUrl({ partnerId, partnerKey, accessToken, shopId, environment, params }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${AMS_PATH}${timestamp}${accessToken}${shopId}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = new URL(AMS_PATH, resolveBaseUrl(environment));
  url.searchParams.set("partner_id", String(Number(partnerId)));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("shop_id", String(Number(shopId)));
  url.searchParams.set("sign", sign);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });
  return { url: url.toString() };
}

async function refreshCookieAccessToken({ partnerId, partnerKey, refreshToken, shopId, environment }) {
  const numericPartnerId = Number(partnerId);
  const numericShopId = Number(shopId);
  if (!Number.isFinite(numericPartnerId) || !Number.isFinite(numericShopId)) {
    return { error: "Cannot refresh Shopee token because partner_id/shop_id is not numeric." };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${REFRESH_PATH}${timestamp}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = new URL(REFRESH_PATH, resolveBaseUrl(environment));
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
    const expiresAt = new Date(Date.now() + expireIn * 1000).toISOString();
    const nextRefreshToken = data.refresh_token || refreshToken;
    const nextShopId = String(data.shop_id || numericShopId);
    return {
      accessToken: String(data.access_token || ""),
      refreshToken: String(nextRefreshToken || ""),
      shopId: nextShopId,
      expiresAt,
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
  return {
    accessToken: cookieSessionExists ? cookieAccessToken : envAccessToken,
    refreshToken: cookieSessionExists ? cookieRefreshToken : envRefreshToken,
    shopId: cookieSessionExists ? cookieShopId : envShopId,
    source: cookieSessionExists ? "cookie" : envAccessToken ? "env" : "none"
  };
}

function extractItems(data) {
  const candidates = [
    data?.response?.items,
    data?.response?.item_list,
    data?.response?.product_list,
    data?.response?.product_performance_list,
    data?.response?.list,
    data?.data?.items,
    data?.data?.item_list,
    data?.data?.product_list,
    data?.items,
    data?.item_list
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeAmsProduct(item, index) {
  const itemId = item.item_id || item.itemid || item.product_id || item.productid;
  const name = cleanText(item.item_name || item.name || item.product_name || item.title);
  if (!itemId && !name) return null;
  const commissionRate = toNumber(item.commission_rate || item.commission_ratio || item.rate || item.commission);
  const sales = toNumber(item.sales || item.gmv || item.revenue);
  const price = normalizePrice(item.price || item.item_price || item.min_price || item.max_price || item.sale_price);
  const itemsSold = toNumber(item.items_sold || item.item_sold || item.sold || item.sales_count);
  const orders = toNumber(item.orders || item.order_count);
  const clicks = toNumber(item.clicks || item.click_count);
  const roi = toNumber(item.roi);
  const score = scoreAmsProduct({ commissionRate, sales, itemsSold, orders, clicks, roi, index });
  const imageUrl = item.image_url || item.image || item.item_image || item.product_image || "";
  const url = item.product_link || item.item_url || item.url || buildShopeeProductUrl(itemId, name);
  return {
    source: "shopee-ams-production",
    item_id: itemId,
    item_name: name,
    name,
    commission_rate: commissionRate,
    commissionRate,
    image_url: imageUrl,
    image: imageUrl,
    sales,
    price,
    priceValue: toNumber(price),
    shop_name: cleanText(item.shop_name || item.shop || item.seller_name || item.store_name),
    shopName: cleanText(item.shop_name || item.shop || item.seller_name || item.store_name),
    items_sold: itemsSold,
    soldCount: itemsSold,
    orders,
    clicks,
    roi,
    est_commission: toNumber(item.est_commission || item.estimated_commission),
    url,
    score,
    chance: score,
    label: score >= 80 ? "HOT" : score >= 60 ? "GOOD" : "LOW",
    validationStatus: "shopee-ams-production"
  };
}

function buildAmsStats(items) {
  const count = items.length;
  const avgCommission = count
    ? Math.round((items.reduce((sum, item) => sum + Number(item.commission_rate || 0), 0) / count) * 100) / 100
    : 0;
  const topCommissionProduct = [...items].sort((a, b) => Number(b.commission_rate || 0) - Number(a.commission_rate || 0))[0] || null;
  return {
    productCount: count,
    averageCommissionRate: avgCommission,
    topCommissionProduct: topCommissionProduct ? {
      item_id: topCommissionProduct.item_id,
      item_name: topCommissionProduct.item_name,
      commission_rate: topCommissionProduct.commission_rate,
      image_url: topCommissionProduct.image_url,
      price: topCommissionProduct.price,
      shop_name: topCommissionProduct.shop_name,
      url: topCommissionProduct.url
    } : null
  };
}

function scoreAmsProduct({ commissionRate, sales, itemsSold, orders, clicks, roi, index }) {
  const commissionScore = Math.min(30, Number(commissionRate || 0) * 1.5);
  const salesScore = normalizeLog(sales, 7) * 25;
  const soldScore = normalizeLog(itemsSold, 5) * 20;
  const orderScore = normalizeLog(orders, 4) * 10;
  const clickScore = normalizeLog(clicks, 5) * 10;
  const roiScore = Math.min(5, Number(roi || 0));
  const rankScore = Math.max(0, 5 - Number(index || 0) * 0.5);
  return Math.max(0, Math.min(100, Math.round(commissionScore + salesScore + soldScore + orderScore + clickScore + roiScore + rankScore)));
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === "") return "";
  const numeric = toNumber(value);
  if (!numeric) return String(value);
  const normalized = numeric > 100000000 ? Math.round(numeric / 100000) : numeric;
  return `Rp${new Intl.NumberFormat("id-ID").format(normalized)}`;
}

function buildShopeeProductUrl(itemId, name) {
  if (!itemId) return `https://shopee.co.id/search?keyword=${encodeURIComponent(name || "")}`;
  return `https://shopee.co.id/search?keyword=${encodeURIComponent(name || itemId)}`;
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

function resolveBaseUrl(value) {
  const env = String(value || "").trim().toLowerCase();
  return /^(test|sandbox|testing|dev|development)$/.test(env) ? TEST_BASE_URL : PRODUCTION_BASE_URL;
}

function serializeCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value || "")}; Max-Age=${Math.max(60, Number(maxAge || 0) || 14400)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toNumber(value) {
  if (typeof value === "number") return value;
  const number = Number(String(value || "0").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLog(value, maxLog) {
  return Math.min(1, Math.log10(Math.max(Number(value || 0), 1)) / maxLog);
}

module.exports = {
  getAmsProductsFromRequest
};
