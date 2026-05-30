const crypto = require("node:crypto");
const { opportunityLabel } = require("./scoring");

const DEFAULT_BASE_URL = "https://partner.shopeemobile.com";
const AMS_PATH = "/api/v2/ams/get_product_performance";
const DEFAULT_PARAMS = {
  period_type: "Last30d",
  order_type: "ConfirmedOrder",
  channel: "AllChannel",
  page_no: 1,
  page_size: 10
};

function isShopeeAmsConfigured() {
  return Boolean(
    process.env.SHOPEE_PARTNER_ID
    && process.env.SHOPEE_PARTNER_KEY
    && process.env.SHOPEE_SHOP_ID
    && process.env.SHOPEE_ACCESS_TOKEN
  );
}

async function getProductPerformance(options = {}) {
  if (!isShopeeAmsConfigured()) {
    const error = new Error("Shopee AMS API belum dikonfigurasi.");
    error.code = "SHOPEE_AMS_NOT_CONFIGURED";
    throw error;
  }

  const params = normalizeParams(options);
  const request = buildSignedRequest(params);
  const response = await fetch(request.url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    }
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error || data.message?.toLowerCase?.().includes("error")) {
    const error = new Error(data.message || data.error || `Shopee AMS request gagal (${response.status}).`);
    error.status = response.status;
    error.response = data;
    throw error;
  }

  const rawItems = extractItems(data);
  const items = rawItems.map(normalizePerformanceItem).filter(Boolean);

  return {
    platform: "shopee-ams",
    configured: true,
    request: params,
    count: items.length,
    items,
    raw: process.env.SHOPEE_AMS_INCLUDE_RAW === "true" ? data : undefined
  };
}

function buildSignedRequest(params) {
  const partnerId = Number(process.env.SHOPEE_PARTNER_ID);
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
  const shopId = Number(process.env.SHOPEE_SHOP_ID);
  const accessToken = process.env.SHOPEE_ACCESS_TOKEN;
  const timestamp = Math.floor(new Date().getTime() / 1000);
  const baseString = `${partnerId}${AMS_PATH}${timestamp}${accessToken}${shopId}`;
  const sign = crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
  const url = new URL(AMS_PATH, process.env.SHOPEE_BASE_URL || DEFAULT_BASE_URL);

  url.searchParams.set("partner_id", String(partnerId));
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("shop_id", String(shopId));
  url.searchParams.set("sign", sign);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  });

  return { url: url.toString(), sign, timestamp };
}

function normalizeParams(options = {}) {
  return {
    period_type: String(options.period_type || DEFAULT_PARAMS.period_type),
    order_type: String(options.order_type || DEFAULT_PARAMS.order_type),
    channel: String(options.channel || DEFAULT_PARAMS.channel),
    page_no: clamp(Number(options.page_no || DEFAULT_PARAMS.page_no), 1, 1000),
    page_size: clamp(Number(options.page_size || DEFAULT_PARAMS.page_size), 1, 100)
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

function normalizePerformanceItem(item) {
  const itemId = item.item_id || item.itemid || item.product_id;
  const itemName = cleanText(item.item_name || item.name || item.product_name);
  if (!itemId && !itemName) return null;

  const sales = toNumber(item.sales);
  const itemsSold = toNumber(item.items_sold || item.item_sold || item.sold);
  const orders = toNumber(item.orders || item.order_count);
  const clicks = toNumber(item.clicks || item.click_count);
  const roi = toNumber(item.roi);
  const totalBuyers = toNumber(item.total_buyers || item.buyers);
  const newBuyers = toNumber(item.new_buyers);
  const estCommission = toNumber(item.est_commission || item.estimated_commission);
  const chance = scoreAffiliatePerformance({ itemsSold, orders, clicks, roi, newBuyers });

  return {
    item_id: itemId,
    item_name: itemName,
    sales,
    items_sold: itemsSold,
    orders,
    clicks,
    est_commission: estCommission,
    roi,
    total_buyers: totalBuyers,
    new_buyers: newBuyers,
    name: itemName,
    soldCount: itemsSold,
    reviewCount: totalBuyers,
    rating: 0,
    score: chance,
    chance,
    label: opportunityLabel(chance),
    image: item.image || item.image_url || "",
    url: item.product_link || item.item_url || ""
  };
}

function scoreAffiliatePerformance({ itemsSold, orders, clicks, roi, newBuyers }) {
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

module.exports = {
  DEFAULT_PARAMS,
  getProductPerformance,
  isShopeeAmsConfigured,
  scoreAffiliatePerformance
};
