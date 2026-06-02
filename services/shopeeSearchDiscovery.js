const SHOPEE_SEARCH_BASE_URL = "https://shopee.co.id";
const SHOPEE_SEARCH_PATH = "/api/v4/search/search_items";
const SHOPEE_SEARCH_BASE = `${SHOPEE_SEARCH_BASE_URL}${SHOPEE_SEARCH_PATH}`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const DEFAULT_MIN_RATING = 4.7;
const DEFAULT_MIN_REVIEWS = 1000;

async function discoverShopeeProducts({
  query,
  terms = [],
  negativeTerms = [],
  limit = 8,
  minRating = DEFAULT_MIN_RATING,
  minReviews = DEFAULT_MIN_REVIEWS,
  disableFiltering = false
} = {}) {
  const searchQuery = cleanText(query || terms[0] || "produk viral");
  const endpoint = buildSearchUrl(searchQuery, Math.max(20, limit * 3));
  const debug = {
    shopee_query: searchQuery,
    source_used: "Shopee Search",
    endpoint,
    request_endpoint: endpoint,
    request_path: SHOPEE_SEARCH_PATH,
    base_url: SHOPEE_SEARCH_BASE_URL,
    environment: String(process.env.SHOPEE_ENV || "public-search").trim() || "public-search",
    partner_id: String(process.env.SHOPEE_PARTNER_ID || "").trim() || null,
    raw_count: 0,
    raw_search_count: 0,
    normalized_count: 0,
    filtered_count: 0,
    min_rating: minRating,
    min_reviews: minReviews,
    filtering_disabled: Boolean(disableFiltering),
    first_10_product_titles: [],
    filter_reasons: [],
    response_status: null,
    content_type: "",
    full_response_body: "",
    error: null
  };

  try {
    const response = await fetchWithTimeout(endpoint, {
      headers: {
        accept: "application/json",
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        referer: `https://shopee.co.id/search?keyword=${encodeURIComponent(searchQuery)}`,
        "user-agent": USER_AGENT,
        "x-requested-with": "XMLHttpRequest"
      }
    }, 9000);
    debug.response_status = response.status;
    debug.content_type = response.headers.get("content-type") || "";
    const text = await response.text();
    debug.full_response_body = text;
    const data = parseJson(text);
    if (!response.ok || !data) {
      debug.error = data?.message || data?.error || `Shopee Search HTTP ${response.status}`;
      debug.body_preview = text.slice(0, 300);
      return { ok: false, items: [], rawItems: [], debug };
    }

    const rawItems = extractRawItems(data);
    debug.raw_count = rawItems.length;
    debug.raw_search_count = rawItems.length;
    const normalized = rawItems.map(normalizeSearchItem).filter(Boolean);
    debug.normalized_count = normalized.length;
    debug.first_10_product_titles = normalized.slice(0, 10).map((item) => item.item_name || item.name || "");
    const ranked = rankAndFilterProducts(normalized, { terms, negativeTerms, minRating, minReviews });
    debug.filter_reasons = ranked.slice(0, Math.max(20, limit)).map((item) => ({
      title: item.item_name || item.name || "",
      rating: item.rating || 0,
      review_count: item.reviewCount || item.reviews || 0,
      reason: item.filtered_reason || "would_pass_filter"
    }));
    const strictItems = ranked.filter((item) => item.qualityPass);
    const unfilteredItems = normalized.slice(0, limit).map((item, index) => ({
      ...item,
      score: item.score || Math.max(40, 90 - index * 2),
      chance: item.chance || Math.max(40, 90 - index * 2),
      label: index < 5 ? "HOT" : "GOOD",
      filter_debug_note: "temporary_unfiltered_search_result"
    }));
    const finalItems = disableFiltering
      ? unfilteredItems
      : (strictItems.length >= Math.min(limit, 4) ? strictItems : ranked).slice(0, limit);
    debug.filtered_count = finalItems.length;
    debug.strict_count = strictItems.length;
    debug.fallback_used = disableFiltering || strictItems.length < Math.min(limit, 4);
    debug.filtered_out_reason = ranked
      .filter((item) => !finalItems.includes(item))
      .slice(0, 8)
      .map((item) => ({
        item_id: item.item_id || "",
        item_name: item.item_name || item.name || "",
        reason: item.filtered_reason || "ranked_lower"
      }));
    return { ok: true, items: finalItems, rawItems: normalized, debug };
  } catch (error) {
    debug.error = error.name === "AbortError" ? "Shopee Search timeout" : error.message;
    return { ok: false, items: [], rawItems: [], debug };
  }
}

function buildSearchUrl(keyword, limit) {
  const url = new URL(SHOPEE_SEARCH_BASE);
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

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractRawItems(data) {
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data?.items)) return data.data.items;
  if (Array.isArray(data?.data?.sections)) return data.data.sections.flatMap((section) => section.items || []);
  if (Array.isArray(data?.response?.items)) return data.response.items;
  return [];
}

function normalizeSearchItem(raw) {
  const item = raw?.item_basic || raw?.item || raw?.ads_item || raw;
  if (!item || typeof item !== "object") return null;
  const itemId = item.itemid || item.item_id;
  const shopId = item.shopid || item.shop_id;
  const name = cleanText(item.name || item.title || item.item_name);
  const price = formatShopeePrice(item.price || item.price_min || item.price_before_discount || item.price_text || item.priceText);
  const image = formatShopeeImage(item.image || item.image_url || item.images?.[0]);
  const rating = roundRating(item.item_rating?.rating_star || item.rating_star || item.rating || 0);
  const reviewCount = extractReviewCount(item);
  const soldCount = Number(item.historical_sold || item.sold || item.monthly_sold || item.global_sold_count || 0) || 0;
  if (!name || !itemId) return null;
  const url = buildProductUrl(name, shopId, itemId);
  return {
    source: "Shopee Search",
    validationStatus: "shopee-search-product",
    item_id: itemId,
    itemid: itemId,
    shop_id: shopId || "",
    shopid: shopId || "",
    item_name: name,
    name,
    price,
    rating,
    reviewCount,
    reviews: reviewCount,
    soldCount,
    items_sold: soldCount,
    image_url: image,
    image,
    shop_name: cleanText(item.shop_name || item.shopname || item.shop_location || ""),
    shopName: cleanText(item.shop_name || item.shopname || item.shop_location || ""),
    product_url: url,
    item_url: url,
    url,
    fallback_search_url: `https://shopee.co.id/search?keyword=${encodeURIComponent(name)}`
  };
}

function rankAndFilterProducts(products, { terms, negativeTerms, minRating, minReviews }) {
  const normalizedTerms = terms.map(normalizeForMatch).filter(Boolean);
  const normalizedNegative = negativeTerms.map(normalizeForMatch).filter(Boolean);
  return products.map((product) => {
    const text = normalizeForMatch(`${product.item_name} ${product.shop_name}`);
    const negativeMatches = normalizedNegative.filter((term) => text.includes(term));
    const positiveMatches = normalizedTerms.filter((term) => text.includes(term));
    const keywordPass = !normalizedTerms.length || positiveMatches.length > 0;
    const ratingPass = !product.rating || product.rating >= minRating;
    const demandPass = Number(product.reviewCount || 0) >= minReviews || Number(product.soldCount || 0) >= minReviews;
    const qualityPass = keywordPass && !negativeMatches.length && ratingPass && demandPass;
    const score = positiveMatches.length * 30
      + normalizeLog(product.soldCount, 5) * 35
      + normalizeLog(product.reviewCount, 5) * 20
      + (product.rating ? Math.min(15, product.rating * 3) : 0);
    return {
      ...product,
      matched_terms: positiveMatches,
      qualityPass,
      score: Math.round(score),
      chance: Math.round(score),
      label: score >= 80 ? "HOT" : score >= 60 ? "GOOD" : "LOW",
      filtered_reason: negativeMatches.length
        ? `rejected_negative:${negativeMatches.slice(0, 3).join("|")}`
        : !keywordPass
          ? "no_keyword_or_category_match"
          : !ratingPass
            ? `rating_below_${minRating}`
            : !demandPass
              ? `reviews_or_sold_below_${minReviews}`
              : ""
    };
  })
    .filter((item) => !item.filtered_reason || item.qualityPass || item.matched_terms.length)
    .sort((a, b) => Number(b.qualityPass) - Number(a.qualityPass) || b.score - a.score || b.soldCount - a.soldCount || b.reviewCount - a.reviewCount);
}

function extractReviewCount(item) {
  const direct = item.cmt_count || item.review_count || item.reviewCount || item.item_rating?.rcount_with_context || 0;
  if (Number(direct)) return Number(direct);
  const ratingCount = item.item_rating?.rating_count || item.rating_count;
  if (Array.isArray(ratingCount)) return ratingCount.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return 0;
}

function formatShopeePrice(value) {
  if (value === undefined || value === null || value === "") return "";
  const numeric = Number(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(numeric) || numeric <= 0) return cleanText(value);
  const normalized = numeric > 100000000 ? Math.round(numeric / 100000) : numeric;
  return `Rp${new Intl.NumberFormat("id-ID").format(normalized)}`;
}

function formatShopeeImage(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  return `https://down-id.img.susercontent.com/file/${raw}`;
}

function buildProductUrl(name, shopId, itemId) {
  if (!shopId || !itemId) return `https://shopee.co.id/search?keyword=${encodeURIComponent(name || itemId || "")}`;
  const slug = String(name || "produk-shopee")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "produk-shopee";
  return `https://shopee.co.id/${slug}-i.${shopId}.${itemId}`;
}

function roundRating(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLog(value, maxLog) {
  return Math.min(1, Math.log10(Math.max(Number(value || 0), 1)) / maxLog);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  discoverShopeeProducts
};
