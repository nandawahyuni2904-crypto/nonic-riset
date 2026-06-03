const crypto = require("node:crypto");

const DEFAULT_GRAPHQL_URL = "https://open-api.affiliate.shopee.co.id/graphql";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const appId = String(process.env.SHOPEE_AFFILIATE_APP_ID || process.env.SHOPEE_APP_ID || "").trim();
  const appSecret = String(process.env.SHOPEE_AFFILIATE_SECRET || process.env.SHOPEE_APP_SECRET || "").trim();
  const graphqlUrl = String(process.env.SHOPEE_AFFILIATE_GRAPHQL_URL || DEFAULT_GRAPHQL_URL).trim();
  const keyword = cleanText(req.query?.keyword || "gelas");

  if (!appId || !appSecret) {
    return res.status(200).json({
      ok: false,
      status: "missing_affiliate_credentials",
      env_required: [
        "SHOPEE_AFFILIATE_APP_ID or SHOPEE_APP_ID",
        "SHOPEE_AFFILIATE_SECRET or SHOPEE_APP_SECRET"
      ],
      env_found: {
        SHOPEE_AFFILIATE_APP_ID: hasEnv("SHOPEE_AFFILIATE_APP_ID"),
        SHOPEE_AFFILIATE_SECRET: hasEnv("SHOPEE_AFFILIATE_SECRET"),
        SHOPEE_APP_ID: hasEnv("SHOPEE_APP_ID"),
        SHOPEE_APP_SECRET: hasEnv("SHOPEE_APP_SECRET")
      },
      endpoints: buildProbeQueries(keyword).map((probe) => ({
        endpoint_name: probe.endpointName,
        request_query: probe.query,
        response_status: null,
        total_products: 0,
        first_20_products: [],
        raw_response: null,
        raw_error: "missing_affiliate_credentials"
      }))
    });
  }

  const endpoints = [];
  for (const probe of buildProbeQueries(keyword)) {
    endpoints.push(await runGraphqlProbe({
      endpointName: probe.endpointName,
      query: probe.query,
      rootField: probe.rootField,
      appId,
      appSecret,
      graphqlUrl
    }));
  }

  return res.status(200).json({
    ok: endpoints.some((endpoint) => endpoint.total_products > 0),
    keyword,
    graphql_url: graphqlUrl,
    endpoints
  });
};

function buildProbeQueries(keyword) {
  const safeKeyword = JSON.stringify(keyword);
  return [
    {
      endpointName: "productOfferV2",
      rootField: "productOfferV2",
      query: `query ProductOfferProbe { productOfferV2(keyword: ${safeKeyword}, sortType: 3, page: 1, limit: 20) { nodes { productId productName commissionRate price imageUrl offerLink shopName soldCount ratingStar } pageInfo { page limit hasNextPage } } }`
    },
    {
      endpointName: "campaignOfferV2",
      rootField: "campaignOfferV2",
      query: "query CampaignOfferProbe { campaignOfferV2(sortType: 3, page: 1, limit: 20) { nodes { offerName commissionRate offerLink imageUrl } pageInfo { page limit hasNextPage } } }"
    },
    {
      endpointName: "shopOfferV2",
      rootField: "shopOfferV2",
      query: `query ShopOfferProbe { shopOfferV2(keyword: ${safeKeyword}, sortType: 3, page: 1, limit: 20) { nodes { shopId shopName commissionRate offerLink imageUrl } pageInfo { page limit hasNextPage } } }`
    }
  ];
}

async function runGraphqlProbe({ endpointName, query, rootField, appId, appSecret, graphqlUrl }) {
  const payload = JSON.stringify({ query });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHash("sha256").update(`${appId}${timestamp}${payload}${appSecret}`).digest("hex");

  const result = {
    endpoint_name: endpointName,
    request_query: query,
    response_status: null,
    total_products: 0,
    first_20_products: [],
    raw_response: null,
    raw_error: null
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
    }, 15000);
    const text = await response.text();
    const parsed = parseJson(text);
    const nodes = extractNodes(parsed, rootField);
    result.response_status = response.status;
    result.total_products = nodes.length;
    result.first_20_products = nodes.slice(0, 20);
    result.raw_response = parsed ?? text;
    if (!response.ok || parsed?.errors) {
      result.raw_error = parsed?.errors || parsed?.error || parsed?.message || `HTTP ${response.status}`;
    }
    return result;
  } catch (error) {
    result.raw_error = error.name === "AbortError" ? "Affiliate probe timeout" : error.message;
    return result;
  }
}

function extractNodes(data, rootField) {
  const direct = data?.data?.[rootField]?.nodes;
  if (Array.isArray(direct)) return direct;
  const list = data?.data?.[rootField]?.list || data?.data?.[rootField]?.items;
  if (Array.isArray(list)) return list;
  return [];
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}
