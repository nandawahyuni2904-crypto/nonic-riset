const SHOPEE_BASE = "https://shopee.co.id";
const SEARCH_PATH = "/api/v4/search/search_items";
const LATEST_CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const keyword = cleanText(req.query?.keyword || "gelas");
  const limit = Math.max(20, Math.min(Number(req.query?.limit || 100) || 100, 100));
  const referer = `${SHOPEE_BASE}/search?keyword=${encodeURIComponent(keyword)}`;
  const cookie = String(process.env.SHOPEE_SEARCH_COOKIE || process.env.SHOPEE_COOKIE || "").trim();
  const results = [];

  results.push(await testDirectApi({ keyword, limit, referer, cookie }));
  results.push(await testBootstrapCookieApi({ keyword, limit, referer, cookie }));
  results.push(await testMobileDomainApi({ keyword, limit, cookie }));
  results.push(await testHtmlSearchParser({ keyword, referer, cookie }));
  results.push(await testAlternateApi({ keyword, limit, referer, cookie }));

  return res.status(200).json({
    ok: results.some((item) => item.product_count > 0),
    keyword,
    source_goal: "Find a Shopee source that returns products without AMS/Affiliate Open API.",
    results
  });
};

async function testDirectApi({ keyword, limit, referer, cookie }) {
  const endpoint = buildSearchApiUrl(SHOPEE_BASE, keyword, limit);
  return runJsonStrategy({
    strategyName: "browser_like_headers_api_v4",
    endpoint,
    headers: buildBrowserHeaders({ referer, cookie, userAgent: LATEST_CHROME_UA })
  });
}

async function testBootstrapCookieApi({ keyword, limit, referer, cookie }) {
  const strategyName = "bootstrap_cookie_then_api_v4";
  try {
    const pageResponse = await fetchWithTimeout(referer, {
      headers: buildPageHeaders({ referer: SHOPEE_BASE, cookie, userAgent: LATEST_CHROME_UA })
    }, 15000);
    const bootstrapCookie = collectSetCookie(pageResponse.headers);
    const mergedCookie = [cookie, bootstrapCookie].filter(Boolean).join("; ");
    const endpoint = buildSearchApiUrl(SHOPEE_BASE, keyword, limit);
    const apiResult = await runJsonStrategy({
      strategyName,
      endpoint,
      headers: buildBrowserHeaders({ referer, cookie: mergedCookie, userAgent: LATEST_CHROME_UA })
    });
    return {
      ...apiResult,
      bootstrap_status: pageResponse.status,
      bootstrap_cookie_count: bootstrapCookie ? bootstrapCookie.split(";").filter(Boolean).length : 0
    };
  } catch (error) {
    return emptyResult(strategyName, {
      status: null,
      endpoint: referer,
      raw_error: error.message
    });
  }
}

async function testMobileDomainApi({ keyword, limit, cookie }) {
  const base = "https://m.shopee.co.id";
  const referer = `${base}/search?keyword=${encodeURIComponent(keyword)}`;
  return runJsonStrategy({
    strategyName: "mobile_domain_api_v4",
    endpoint: buildSearchApiUrl(base, keyword, limit),
    headers: buildBrowserHeaders({ referer, cookie, userAgent: MOBILE_UA, mobile: true })
  });
}

async function testHtmlSearchParser({ keyword, referer, cookie }) {
  const strategyName = "search_html_page_parser";
  try {
    const response = await fetchWithTimeout(referer, {
      headers: buildPageHeaders({ referer: SHOPEE_BASE, cookie, userAgent: LATEST_CHROME_UA })
    }, 15000);
    const text = await response.text();
    const titles = extractTitlesFromHtml(text);
    return {
      strategy_name: strategyName,
      endpoint: referer,
      status: response.status,
      product_count: titles.length,
      error_code: extractShopeeErrorCode(text),
      sample_titles: titles.slice(0, 20),
      content_type: response.headers.get("content-type") || "",
      raw_error: titles.length ? null : detectHtmlBlockReason(text),
      body_preview: text.slice(0, 500)
    };
  } catch (error) {
    return emptyResult(strategyName, {
      status: null,
      endpoint: referer,
      raw_error: error.message
    });
  }
}

async function testAlternateApi({ keyword, limit, referer, cookie }) {
  const endpoint = buildAlternateSearchUrl(keyword, limit);
  return runJsonStrategy({
    strategyName: "alternate_search_api_v2",
    endpoint,
    headers: buildBrowserHeaders({ referer, cookie, userAgent: LATEST_CHROME_UA })
  });
}

async function runJsonStrategy({ strategyName, endpoint, headers }) {
  try {
    const response = await fetchWithTimeout(endpoint, { headers }, 15000);
    const text = await response.text();
    const data = parseJson(text);
    const items = extractRawItems(data);
    const titles = items.map(extractTitle).filter(Boolean);
    return {
      strategy_name: strategyName,
      endpoint,
      status: response.status,
      product_count: titles.length,
      error_code: extractErrorCode(data, text),
      sample_titles: titles.slice(0, 20),
      content_type: response.headers.get("content-type") || "",
      raw_error: response.ok ? null : (data?.message || data?.error_msg || data?.error || text.slice(0, 300)),
      body_preview: text.slice(0, 500)
    };
  } catch (error) {
    return emptyResult(strategyName, {
      status: null,
      endpoint,
      raw_error: error.message
    });
  }
}

function buildSearchApiUrl(base, keyword, limit) {
  const url = new URL(SEARCH_PATH, base);
  url.searchParams.set("by", "relevancy");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("newest", "0");
  url.searchParams.set("order", "desc");
  url.searchParams.set("page_type", "search");
  url.searchParams.set("scenario", "PAGE_GLOBAL_SEARCH");
  url.searchParams.set("version", "2");
  return url.toString();
}

function buildAlternateSearchUrl(keyword, limit) {
  const url = new URL("/api/v2/search_items/", SHOPEE_BASE);
  url.searchParams.set("by", "relevancy");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("newest", "0");
  url.searchParams.set("order", "desc");
  return url.toString();
}

function buildBrowserHeaders({ referer, cookie, userAgent, mobile = false }) {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer,
    origin: SHOPEE_BASE,
    "user-agent": userAgent,
    "x-api-source": mobile ? "rn" : "pc",
    "x-requested-with": "XMLHttpRequest",
    "sec-ch-ua": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": mobile ? "?1" : "?0",
    "sec-ch-ua-platform": mobile ? '"Android"' : '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...(cookie ? { cookie } : {})
  };
}

function buildPageHeaders({ referer, cookie, userAgent }) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer,
    "user-agent": userAgent,
    "sec-ch-ua": '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "upgrade-insecure-requests": "1",
    ...(cookie ? { cookie } : {})
  };
}

function extractRawItems(data) {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data?.sections)) return data.data.sections.flatMap((section) => section.items || []);
  if (Array.isArray(data?.response?.items)) return data.response.items;
  if (Array.isArray(data?.item)) return data.item;
  return [];
}

function extractTitle(raw) {
  const item = raw?.item_basic || raw?.item || raw?.ads_item || raw;
  return cleanText(item?.name || item?.title || item?.item_name || "");
}

function extractTitlesFromHtml(html) {
  const titles = new Set();
  const nextDataMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    const parsed = parseJson(nextDataMatch[1]);
    collectNamesDeep(parsed, titles);
  }
  return [...titles];
}

function collectNamesDeep(value, titles) {
  if (!value || titles.size >= 80) return;
  if (Array.isArray(value)) return value.forEach((item) => collectNamesDeep(item, titles));
  if (typeof value !== "object") return;
  const hasProductShape = Boolean(
    value.itemid || value.item_id || value.shopid || value.shop_id || value.price || value.price_min || value.image || value.image_url
  );
  const name = cleanText(value.name || value.item_name || value.title || "");
  if (hasProductShape && looksLikeProductTitle(name)) titles.add(name);
  Object.values(value).forEach((item) => collectNamesDeep(item, titles));
}

function looksLikeProductTitle(value) {
  const text = cleanText(value);
  if (text.length < 8 || text.length > 180) return false;
  if (/captcha|login|shopee|javascript|tracking|error|tanstack|react|query|webpack|chunk|module/i.test(text)) return false;
  return /[a-zA-Z0-9]/.test(text);
}

function extractErrorCode(data, text) {
  return data?.error || data?.error_code || data?.code || extractShopeeErrorCode(text) || null;
}

function extractShopeeErrorCode(text) {
  const match = String(text || "").match(/"error"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function detectHtmlBlockReason(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("captcha")) return "captcha_or_anti_bot_page";
  if (value.includes("terjadi kesalahan")) return "shopee_error_page";
  if (value.includes("login")) return "login_required_or_guest_limited";
  return "no_product_data_found_in_html";
}

function emptyResult(strategyName, extra = {}) {
  return {
    strategy_name: strategyName,
    endpoint: extra.endpoint || "",
    status: extra.status ?? null,
    product_count: 0,
    error_code: extra.error_code ?? null,
    sample_titles: [],
    raw_error: extra.raw_error || null
  };
}

function collectSetCookie(headers) {
  const values = [];
  if (typeof headers.getSetCookie === "function") values.push(...headers.getSetCookie());
  const single = headers.get("set-cookie");
  if (single) values.push(single);
  return values.map((value) => String(value).split(";")[0]).filter(Boolean).join("; ");
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
