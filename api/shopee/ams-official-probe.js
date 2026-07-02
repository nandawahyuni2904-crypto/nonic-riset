const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TOKEN_FILE = path.join(__dirname, "..", "..", "data", "shopee-token.json");
const PRODUCTION_BASE_URL = "https://partner.shopeemobile.com";
const SANDBOX_BASE_URL = "https://openplatform.sandbox.test-stable.shopee.sg";

const OFFICIAL_AMS_ENDPOINTS = [
  {
    endpoint_name: "product_recommendation",
    request_path: "/api/v2/ams/get_optimization_suggestion_product",
    request_params: {
      page_no: 1,
      page_size: 10
    }
  },
  {
    endpoint_name: "suggested_products",
    request_path: "/api/v2/ams/batch_get_products_suggested_rate",
    request_params: {
      item_id_list: []
    }
  },
  {
    endpoint_name: "open_campaign_products",
    request_path: "/api/v2/ams/get_open_campaign_added_product",
    request_params: {
      page_no: 1,
      page_size: 10
    }
  },
  {
    endpoint_name: "product_performance",
    request_path: "/api/v2/ams/get_product_performance",
    request_params: {
      period_type: "Last30d",
      order_type: "ConfirmedOrder",
      channel: "AllChannel",
      page_no: 1,
      page_size: 10
    }
  }
];

async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const config = getConfig();
  const tokenInfo = getTokenInfo(req, config);
  const missing = getMissingConfig(config, tokenInfo);

  if (missing.length) {
    return res.status(200).json({
      results: OFFICIAL_AMS_ENDPOINTS.map((endpoint) => ({
        endpoint_name: endpoint.endpoint_name,
        request_path: endpoint.request_path,
        request_params: endpoint.request_params,
        response_status: null,
        total_products: 0,
        sample_products: [],
        raw_error: `Missing Shopee config: ${missing.join(", ")}`
      }))
    });
  }

  const results = [];
  for (const endpoint of OFFICIAL_AMS_ENDPOINTS) {
    results.push(await probeEndpoint({
      endpoint,
      config,
      tokenInfo
    }));
  }

  return res.status(200).json({ results });
}

async function probeEndpoint({ endpoint, config, tokenInfo }) {
  const request = buildSignedGetRequest({
    config,
    tokenInfo,
    request_path: endpoint.request_path,
    request_params: endpoint.request_params
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(request.url, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    const text = await response.text();
    const data = parseJson(text);
    const products = extractProducts(data);

    return {
      endpoint_name: endpoint.endpoint_name,
      request_path: endpoint.request_path,
      request_params: request.redacted_params,
      response_status: response.status,
      total_products: getTotalProducts(data, products),
      sample_products: products.slice(0, 3),
      raw_error: extractRawError(data, text)
    };
  } catch (error) {
    return {
      endpoint_name: endpoint.endpoint_name,
      request_path: endpoint.request_path,
      request_params: request.redacted_params,
      response_status: null,
      total_products: 0,
      sample_products: [],
      raw_error: error.name === "AbortError" ? "Shopee AMS request timeout." : error.message
    };
  }
}

function buildSignedGetRequest({ config, tokenInfo, request_path, request_params }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const shopId = String(tokenInfo.shopId || config.shopId || "").trim();
  const accessToken = String(tokenInfo.accessToken || "").trim();
  const baseString = `${config.partnerId}${request_path}${timestamp}${accessToken}${shopId}`;
  const sign = crypto.createHmac("sha256", config.partnerKey).update(baseString).digest("hex");
  const url = new URL(request_path, config.baseUrl);
  const signedParams = {
    partner_id: String(Number(config.partnerId)),
    timestamp,
    access_token: accessToken,
    shop_id: String(Number(shopId)),
    sign,
    ...request_params
  };

  Object.entries(signedParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      url.searchParams.set(key, JSON.stringify(value));
      return;
    }
    url.searchParams.set(key, String(value));
  });

  return {
    url: url.toString(),
    redacted_params: redactParams(signedParams)
  };
}

function getConfig() {
  const environment = String(process.env.SHOPEE_ENV || process.env.SHOPEE_OPEN_ENV || "production").trim().toLowerCase();
  const baseUrl = String(
    process.env.SHOPEE_OPEN_BASE_URL
    || process.env.SHOPEE_BASE_URL
    || (/^(sandbox|test|testing|dev|development)$/.test(environment) ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL)
  ).trim();

  return {
    environment,
    baseUrl,
    partnerId: String(process.env.SHOPEE_PARTNER_ID || process.env.SHOPEE_TEST_PARTNER_ID || "").trim(),
    partnerKey: String(process.env.SHOPEE_PARTNER_KEY || process.env.SHOPEE_TEST_PARTNER_KEY || "").trim(),
    accessToken: String(process.env.SHOPEE_ACCESS_TOKEN || "").trim(),
    shopId: String(process.env.SHOPEE_SHOP_ID || "").trim()
  };
}

function getTokenInfo(req, config) {
  const tokenFile = readTokenFile();
  const cookies = parseCookies(req);
  const cookieAccessToken = String(cookies.SHOPEE_ACCESS_TOKEN || "").trim();
  const cookieShopId = String(cookies.SHOPEE_SHOP_ID || "").trim();
  const fileAccessToken = String(tokenFile?.access_token || "").trim();
  const fileShopId = String(tokenFile?.shop_id || "").trim();

  if (fileAccessToken) {
    return {
      accessToken: fileAccessToken,
      shopId: fileShopId || config.shopId,
      source: "data/shopee-token.json"
    };
  }

  if (cookieAccessToken) {
    return {
      accessToken: cookieAccessToken,
      shopId: cookieShopId || config.shopId,
      source: "cookie"
    };
  }

  return {
    accessToken: config.accessToken,
    shopId: config.shopId,
    source: config.accessToken ? "env" : "none"
  };
}

function getMissingConfig(config, tokenInfo) {
  const missing = [];
  if (!config.partnerId) missing.push("SHOPEE_PARTNER_ID");
  if (!config.partnerKey) missing.push("SHOPEE_PARTNER_KEY");
  if (!tokenInfo.accessToken) missing.push("SHOPEE_ACCESS_TOKEN");
  if (!tokenInfo.shopId) missing.push("SHOPEE_SHOP_ID");
  if (config.partnerId && !Number.isFinite(Number(config.partnerId))) missing.push("SHOPEE_PARTNER_ID_NUMERIC");
  if (tokenInfo.shopId && !Number.isFinite(Number(tokenInfo.shopId))) missing.push("SHOPEE_SHOP_ID_NUMERIC");
  return missing;
}

function extractProducts(data) {
  const candidates = [
    data?.response?.product_list,
    data?.response?.item_list,
    data?.response?.items,
    data?.response?.products,
    data?.response?.product_performance_list,
    data?.response?.optimization_suggestion_product_list,
    data?.response?.suggestion_product_list,
    data?.response?.list,
    data?.data?.product_list,
    data?.data?.item_list,
    data?.data?.items,
    data?.product_list,
    data?.item_list,
    data?.items
  ];

  return candidates.find(Array.isArray) || [];
}

function getTotalProducts(data, products) {
  const total = data?.response?.total_count
    ?? data?.response?.total
    ?? data?.response?.total_num
    ?? data?.data?.total_count
    ?? data?.data?.total
    ?? products.length;
  const numeric = Number(total);
  return Number.isFinite(numeric) ? numeric : products.length;
}

function extractRawError(data, text) {
  if (data && typeof data === "object") {
    return data.error
      || data.error_msg
      || data.error_message
      || data.message
      || data.msg
      || null;
  }
  return text ? String(text).slice(0, 500) : null;
}

function redactParams(params) {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    if (/access_token|sign/i.test(key)) return [key, `REDACTED:${String(value || "").length}`];
    return [key, value];
  }));
}

function readTokenFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = handler;
module.exports.default = handler;
