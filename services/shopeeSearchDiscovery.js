const SHOPEE_SEARCH_BASE_URL = "https://shopee.co.id";
const SHOPEE_SEARCH_PATH = "/api/v4/search/search_items";
const SHOPEE_SEARCH_BASE = `${SHOPEE_SEARCH_BASE_URL}${SHOPEE_SEARCH_PATH}`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const DEFAULT_MIN_RATING = 4.7;
const DEFAULT_MIN_REVIEWS = 1000;
const PRODUCT_DISCOVERY_UNAVAILABLE = "Shopee product discovery belum tersedia, hanya AMS campaign tersedia.";

async function discoverShopeeProducts({
  query,
  terms = [],
  negativeTerms = [],
  limit = 20,
  minRating = DEFAULT_MIN_RATING,
  minReviews = DEFAULT_MIN_REVIEWS,
  disableFiltering = false
} = {}) {
  const searchQuery = cleanText(query || terms[0] || "produk viral");
  const candidateTarget = Math.max(100, limit * 5);
  const endpoint = buildSearchUrl(searchQuery, candidateTarget);
  const referer = `https://shopee.co.id/search?keyword=${encodeURIComponent(searchQuery)}`;
  const cookie = String(process.env.SHOPEE_SEARCH_COOKIE || process.env.SHOPEE_COOKIE || "").trim();
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
    candidate_count: 0,
    filtered_count: 0,
    top_20_count: 0,
    min_rating: minRating,
    min_reviews: minReviews,
    filtering_disabled: Boolean(disableFiltering),
    first_10_product_titles: [],
    filter_reasons: [],
    response_status: null,
    content_type: "",
    full_response_body: "",
    method_used: "direct_search_api",
    cookie_configured: Boolean(cookie),
    bootstrap_cookie_count: 0,
    discovery_error_message: "",
    error: null
  };

  try {
    const response = await fetchSearchApi({ endpoint, referer, cookie, debug });
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
    const ranked = scoreTrendingProducts(normalized, { terms, negativeTerms, minRating, minReviews });
    debug.candidate_count = normalized.length;
    debug.filter_reasons = ranked.slice(0, Math.max(20, limit)).map((item) => ({
      title: item.item_name || item.name || "",
      rating: item.rating || 0,
      review_count: item.reviewCount || item.reviews || 0,
      reason: item.filtered_reason || item.scoring_reason || "would_pass_filter"
    }));
    const strictItems = ranked.filter((item) => item.qualityPass);
    const finalItems = disableFiltering
      ? ranked.slice(0, limit)
      : (strictItems.length >= Math.min(limit, 4) ? strictItems : ranked.filter((item) => item.keyword_match_score >= 18)).slice(0, limit);
    debug.filtered_count = finalItems.length;
    debug.top_20_count = finalItems.slice(0, 20).length;
    debug.strict_count = strictItems.length;
    debug.fallback_used = disableFiltering || strictItems.length < Math.min(limit, 4);
    debug.scoring_reason = "trending_score = keyword_match*30 + rating_score*20 + review_score*15 + sold_velocity_score*25 + freshness_score*10. Mature products get a small penalty so 100k sold items do not always win.";
    debug.filtered_out_reason = ranked
      .filter((item) => !finalItems.includes(item))
      .slice(0, 8)
      .map((item) => ({
        item_id: item.item_id || "",
        item_name: item.item_name || item.name || "",
        reason: item.filtered_reason || "ranked_lower"
      }));
    if (!finalItems.length) {
      debug.error = PRODUCT_DISCOVERY_UNAVAILABLE;
      debug.discovery_error_message = PRODUCT_DISCOVERY_UNAVAILABLE;
      return { ok: false, items: [], rawItems: normalized, debug };
    }
    return { ok: true, items: finalItems, rawItems: normalized, debug };
  } catch (error) {
    debug.error = error.name === "AbortError" ? "Shopee Search timeout" : error.message;
    debug.discovery_error_message = PRODUCT_DISCOVERY_UNAVAILABLE;
    return { ok: false, items: [], rawItems: [], debug };
  }
}

async function fetchSearchApi({ endpoint, referer, cookie, debug }) {
  const directResponse = await fetchWithTimeout(endpoint, {
    headers: buildSearchHeaders({ referer, cookie })
  }, 12000);
  if (directResponse.ok || directResponse.status !== 403) return directResponse;

  debug.method_used = "bootstrap_cookie_then_search_api";
  const bootstrap = await fetchWithTimeout(referer, {
    headers: buildPageHeaders({ referer, cookie })
  }, 12000);
  const bootstrapCookie = collectSetCookie(bootstrap.headers);
  debug.bootstrap_cookie_count = bootstrapCookie ? bootstrapCookie.split(";").filter(Boolean).length : 0;
  const mergedCookie = [cookie, bootstrapCookie].filter(Boolean).join("; ");
  if (!mergedCookie) return directResponse;

  const retryResponse = await fetchWithTimeout(endpoint, {
    headers: buildSearchHeaders({ referer, cookie: mergedCookie })
  }, 12000);
  debug.method_used = retryResponse.ok ? "bootstrap_cookie_retry_success" : "bootstrap_cookie_retry_failed";
  return retryResponse;
}

function buildSearchHeaders({ referer, cookie }) {
  return {
    accept: "application/json",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    referer,
    origin: SHOPEE_SEARCH_BASE_URL,
    "user-agent": USER_AGENT,
    "x-api-source": "pc",
    "x-requested-with": "XMLHttpRequest",
    ...(cookie ? { cookie } : {})
  };
}

function buildPageHeaders({ referer, cookie }) {
  return {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    referer,
    "user-agent": USER_AGENT,
    ...(cookie ? { cookie } : {})
  };
}

function collectSetCookie(headers) {
  const values = [];
  if (typeof headers.getSetCookie === "function") values.push(...headers.getSetCookie());
  const single = headers.get("set-cookie");
  if (single) values.push(single);
  return values
    .map((value) => String(value).split(";")[0])
    .filter(Boolean)
    .join("; ");
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
  const createdAt = normalizeTimestamp(item.ctime || item.created_time || item.create_time || item.item_creation_time || 0);
  const updatedAt = normalizeTimestamp(item.updated_time || item.update_time || 0);
  if (!name || !itemId || !shopId) return null;
  const url = buildProductUrl(name, shopId, itemId);
  if (!isDirectProductUrl(url)) return null;
  return {
    source: "Shopee Search",
    validationStatus: "shopee-search-product",
    item_id: itemId,
    itemid: itemId,
    shop_id: shopId || "",
    shopid: shopId || "",
    item_name: name,
    name,
    title: name,
    price,
    rating,
    reviewCount,
    reviews: reviewCount,
    soldCount,
    sold: soldCount,
    sold_count: soldCount,
    items_sold: soldCount,
    created_at: createdAt,
    updated_at: updatedAt,
    freshness_days: createdAt ? Math.max(0, Math.round((Date.now() - createdAt) / 86400000)) : null,
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

function scoreTrendingProducts(products, { terms, negativeTerms, minRating, minReviews }) {
  const normalizedTerms = terms.map(normalizeForMatch).filter(Boolean);
  const normalizedNegative = negativeTerms.map(normalizeForMatch).filter(Boolean);
  return products.map((product) => {
    const text = normalizeForMatch(`${product.item_name} ${product.shop_name}`);
    const negativeMatches = normalizedNegative.filter((term) => text.includes(term));
    const positiveMatches = normalizedTerms.filter((term) => text.includes(term));
    const keywordMatchScore = scoreKeywordMatch({ text, productName: product.item_name, normalizedTerms, positiveMatches });
    const keywordPass = !normalizedTerms.length || keywordMatchScore >= 18;
    const ratingPass = !product.rating || product.rating >= minRating;
    const demandPass = Number(product.reviewCount || 0) >= Math.min(minReviews, 300) || Number(product.soldCount || 0) >= Math.min(minReviews, 300);
    const qualityPass = keywordPass && !negativeMatches.length && ratingPass && demandPass;
    const ratingScore = scoreRating(product.rating);
    const reviewScore = normalizeLog(product.reviewCount, 5) * 15;
    const soldVelocityScore = scoreSoldVelocity(product.soldCount);
    const freshnessScore = scoreFreshness(product.freshness_days);
    const maturePenalty = scoreMaturityPenalty(product.soldCount, product.reviewCount);
    const score = Math.max(0, Math.min(100, keywordMatchScore + ratingScore + reviewScore + soldVelocityScore + freshnessScore - maturePenalty));
    const reason = buildTrendingReason({
      positiveMatches,
      keywordMatchScore,
      ratingScore,
      reviewScore,
      soldVelocityScore,
      freshnessScore,
      maturePenalty,
      product
    });
    return {
      ...product,
      matched_terms: positiveMatches,
      qualityPass,
      rank: 0,
      keyword_match_score: Math.round(keywordMatchScore),
      rating_score: Math.round(ratingScore),
      review_score: Math.round(reviewScore),
      sold_velocity_score: Math.round(soldVelocityScore),
      freshness_score: Math.round(freshnessScore),
      mature_penalty: Math.round(maturePenalty),
      trending_score: Math.round(score),
      popularity_signal: Math.round(soldVelocityScore + reviewScore + ratingScore),
      trending_reason: reason,
      scoring_reason: reason,
      why_trending: reason,
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
    .filter((item) => !item.filtered_reason || item.qualityPass || item.keyword_match_score >= 18)
    .sort((a, b) => Number(b.qualityPass) - Number(a.qualityPass) || b.trending_score - a.trending_score || b.keyword_match_score - a.keyword_match_score || b.sold_velocity_score - a.sold_velocity_score)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function scoreKeywordMatch({ text, productName, normalizedTerms, positiveMatches }) {
  if (!normalizedTerms.length) return 20;
  const productText = normalizeForMatch(productName);
  const exactPhrase = normalizedTerms.some((term) => term.length > 3 && productText.includes(term));
  const wordHits = positiveMatches.length;
  const ratio = wordHits / Math.max(1, normalizedTerms.length);
  return Math.min(30, (exactPhrase ? 18 : 0) + ratio * 12 + Math.min(8, wordHits * 2) + (text.includes(normalizedTerms[0]) ? 4 : 0));
}

function scoreRating(value) {
  const rating = Number(value || 0);
  if (!rating) return 8;
  if (rating >= 4.9) return 20;
  if (rating >= 4.8) return 18;
  if (rating >= 4.7) return 16;
  if (rating >= 4.5) return 10;
  return 4;
}

function scoreSoldVelocity(value) {
  const sold = Number(value || 0);
  if (!sold) return 4;
  const base = normalizeLog(sold, 5) * 25;
  const emergingBoost = sold >= 100 && sold <= 10000 ? 4 : 0;
  return Math.min(25, base + emergingBoost);
}

function scoreFreshness(days) {
  if (days === null || days === undefined) return 5;
  const value = Number(days);
  if (value <= 14) return 10;
  if (value <= 30) return 8;
  if (value <= 90) return 5;
  return 2;
}

function scoreMaturityPenalty(soldCount, reviewCount) {
  const sold = Number(soldCount || 0);
  const reviews = Number(reviewCount || 0);
  if (sold >= 100000 || reviews >= 50000) return 10;
  if (sold >= 50000 || reviews >= 20000) return 6;
  if (sold >= 20000 || reviews >= 10000) return 3;
  return 0;
}

function buildTrendingReason({ positiveMatches, keywordMatchScore, ratingScore, reviewScore, soldVelocityScore, freshnessScore, maturePenalty, product }) {
  const parts = [];
  if (positiveMatches.length) parts.push(`keyword match kuat: ${positiveMatches.slice(0, 4).join(", ")}`);
  if (ratingScore >= 16) parts.push(`rating bagus ${product.rating || "-"}`);
  if (reviewScore >= 8) parts.push(`review cukup kuat ${product.reviewCount || 0}`);
  if (soldVelocityScore >= 15) parts.push(`sinyal terjual naik ${product.soldCount || 0}`);
  if (freshnessScore >= 8) parts.push("produk relatif baru");
  if (maturePenalty) parts.push(`penalty mature -${Math.round(maturePenalty)}`);
  if (!parts.length) parts.push(`score keyword ${Math.round(keywordMatchScore)} dengan popularity signal terbatas`);
  return parts.join("; ");
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
  const slug = String(name || "produk-shopee")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "produk-shopee";
  return `https://shopee.co.id/${slug}-i.${shopId}.${itemId}`;
}

function isDirectProductUrl(url) {
  return /-i\.\d+\.\d+/.test(String(url || ""));
}

function roundRating(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0;
}

function normalizeTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return null;
  const millis = number > 1000000000000 ? number : number * 1000;
  return millis > 0 ? millis : null;
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
  discoverShopeeProducts,
  PRODUCT_DISCOVERY_UNAVAILABLE
};
