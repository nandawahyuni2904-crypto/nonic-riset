const crypto = require("node:crypto");

const DEFAULT_AFFILIATE_GRAPHQL_URL = "https://open-api.affiliate.shopee.co.id/graphql";

async function probeShopeeAffiliateEndpoints({ query = "", limit = 50 } = {}) {
  const appId = String(process.env.SHOPEE_AFFILIATE_APP_ID || process.env.SHOPEE_APP_ID || "").trim();
  const secret = String(process.env.SHOPEE_AFFILIATE_SECRET || process.env.SHOPEE_APP_SECRET || "").trim();
  const graphqlUrl = String(process.env.SHOPEE_AFFILIATE_GRAPHQL_URL || DEFAULT_AFFILIATE_GRAPHQL_URL).trim();
  const candidates = buildCandidates({ query, limit });

  if (!appId || !secret) {
    return {
      ok: false,
      configured: false,
      source: "shopee-affiliate-open-api",
      message: "Shopee Affiliate Open API belum dikonfigurasi. Isi SHOPEE_AFFILIATE_APP_ID dan SHOPEE_AFFILIATE_SECRET.",
      candidates: candidates.map((candidate) => ({
        name: candidate.name,
        endpoint: graphqlUrl,
        graphql_field: candidate.graphqlField,
        product_count: 0,
        products: [],
        first_20_products: [],
        error: "missing_affiliate_credentials"
      })),
      products: []
    };
  }

  const results = [];
  for (const candidate of candidates) {
    results.push(await callAffiliateGraphql({ appId, secret, graphqlUrl, candidate }));
  }
  const products = results.flatMap((result) => result.products || []);
  return {
    ok: products.length > 0,
    configured: true,
    source: "shopee-affiliate-open-api",
    message: products.length ? "Shopee Affiliate Open API mengembalikan produk." : "Belum ada produk dari kandidat Shopee Affiliate Open API.",
    candidates: results,
    products
  };
}

function buildCandidates({ query, limit }) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 50));
  const keywordArg = query ? `, keyword: ${JSON.stringify(query)}` : "";
  return [
    {
      name: "Product Offer List",
      graphqlField: "productOfferV2",
      query: `query ProductOfferList { productOfferV2(listType: 0, sortType: 5, page: 0, limit: ${safeLimit}${keywordArg}) { nodes { productName commissionRate commission price priceMax productLink offerLink imageUrl } } }`,
      pickPath: ["data", "productOfferV2", "nodes"]
    },
    {
      name: "Product Offer List - AMS Offers",
      graphqlField: "productOfferV2",
      query: `query ProductAmsOfferList { productOfferV2(listType: 0, sortType: 5, page: 0, limit: ${safeLimit}, isAMSOffer: true${keywordArg}) { nodes { productName commissionRate commission price priceMax productLink offerLink imageUrl } } }`,
      pickPath: ["data", "productOfferV2", "nodes"]
    },
    {
      name: "Shopee Campaign Offer List",
      graphqlField: "shopeeOfferV2",
      query: `query ShopeeCampaignOfferList { shopeeOfferV2(listType: 0, sortType: 5, page: 0, limit: ${safeLimit}) { nodes { offerName commissionRate commission offerLink imageUrl } } }`,
      pickPath: ["data", "shopeeOfferV2", "nodes"]
    },
    {
      name: "Shop Offer List",
      graphqlField: "shopOfferV2",
      query: `query ShopOfferList { shopOfferV2(listType: 0, sortType: 5, page: 0, limit: ${safeLimit}) { nodes { shopName commissionRate commission offerLink imageUrl } } }`,
      pickPath: ["data", "shopOfferV2", "nodes"]
    }
  ];
}

async function callAffiliateGraphql({ appId, secret, graphqlUrl, candidate }) {
  const payload = JSON.stringify({ query: candidate.query, operationName: null, variables: {} });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHash("sha256").update(`${appId}${timestamp}${payload}${secret}`).digest("hex");
  const endpointResult = {
    name: candidate.name,
    endpoint: graphqlUrl,
    graphql_field: candidate.graphqlField,
    request_body: payload,
    response_status: null,
    product_count: 0,
    products: [],
    sample_products: [],
    first_20_products: [],
    error: null,
    response_body_preview: ""
  };

  try {
    const response = await fetchWithTimeout(graphqlUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        appid: appId,
        app_id: appId,
        timestamp,
        signature,
        authorization: `SHA256 Credential=${appId},Timestamp=${timestamp},Signature=${signature}`
      },
      body: payload
    }, 10000);
    const text = await response.text();
    endpointResult.response_status = response.status;
    endpointResult.response_body_preview = text.slice(0, 1000);
    const data = parseJson(text);
    if (!response.ok || data?.errors) {
      endpointResult.error = data?.errors?.[0]?.message || data?.message || `Affiliate GraphQL HTTP ${response.status}`;
      return endpointResult;
    }
    const rawProducts = pickPath(data, candidate.pickPath);
    const products = Array.isArray(rawProducts) ? rawProducts.map((item, index) => normalizeAffiliateProduct(item, candidate, index)).filter(Boolean) : [];
    endpointResult.product_count = products.length;
    endpointResult.products = products;
    endpointResult.sample_products = products.slice(0, 20).map(toSampleProduct);
    endpointResult.first_20_products = endpointResult.sample_products;
    return endpointResult;
  } catch (error) {
    endpointResult.error = error.name === "AbortError" ? "Affiliate GraphQL timeout" : error.message;
    return endpointResult;
  }
}

function normalizeAffiliateProduct(item, candidate, index) {
  const name = cleanText(item.productName || item.offerName || item.shopName || item.name || "");
  if (!name) return null;
  const commissionRate = toNumber(item.commissionRate || item.commission_rate || item.rate || 0);
  const price = item.price || item.priceMax || "";
  const url = item.productLink || item.offerLink || "";
  const score = Math.max(30, Math.min(100, Math.round((commissionRate <= 1 ? commissionRate * 100 : commissionRate) + Math.max(0, 20 - index))));
  return {
    source: "Shopee Affiliate Open API",
    validationStatus: "shopee-affiliate-open-api",
    item_id: item.itemId || item.item_id || "",
    item_name: name,
    name,
    price,
    commission_rate: commissionRate,
    commissionRate,
    image_url: item.imageUrl || item.image_url || "",
    image: item.imageUrl || item.image_url || "",
    product_url: url,
    item_url: url,
    url,
    campaign_status: candidate.graphqlField,
    affiliate_endpoint: candidate.name,
    score,
    chance: score,
    label: score >= 80 ? "HOT" : score >= 60 ? "GOOD" : "LOW"
  };
}

function toSampleProduct(item) {
  return {
    title: item.item_name || item.name || "",
    commission_rate: item.commission_rate || 0,
    campaign_status: item.campaign_status || "",
    url: item.url || ""
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pickPath(value, path) {
  return path.reduce((acc, key) => acc?.[key], value);
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

module.exports = {
  probeShopeeAffiliateEndpoints
};
