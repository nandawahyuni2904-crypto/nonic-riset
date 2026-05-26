const { extractProductKeywords } = require("./keywordExtraction");
const { getAmsProductPerformance, getStatus: getShopeeStatus, buildAuthUrl } = require("./shopeeOpen");
const { keywordRelevance, normalizeRating, normalizeReview, normalizeSold } = require("./scoring");
const { shopeeApiLog } = require("./logger");

const LIVE_CACHE_TTL_MS = Number(process.env.SHOPEE_LIVE_CACHE_TTL_MS || 15 * 60 * 1000);
let performanceCache = null;

async function getSellerConnectionDashboard() {
  const status = await getShopeeStatus();
  let reconnectUrl = "";
  if (status.configured && (!status.authorized || status.tokenExpired)) {
    try {
      reconnectUrl = buildAuthUrl().authUrl;
    } catch {
      reconnectUrl = "";
    }
  }

  return {
    configured: status.configured,
    authorized: status.authorized,
    environment: status.environment,
    tokenStatus: status.tokenStatus,
    tokenExpiry: status.expiresAt,
    expiresInSeconds: status.expiresInSeconds,
    shopRegion: status.shopRegion,
    connectedShops: status.connectedShops || [],
    reconnectRequired: Boolean(status.configured && (!status.authorized || status.tokenExpired)),
    reconnectUrl,
    message: buildConnectionMessage(status)
  };
}

async function validateShopeeProducts({ shorts = [], keywords = [], limit = 12 } = {}) {
  const connection = await getSellerConnectionDashboard();
  if (!connection.configured) {
    return {
      connection,
      validatedProducts: [],
      message: "Shopee Open Platform belum dikonfigurasi."
    };
  }
  if (!connection.authorized || connection.tokenStatus === "expired") {
    return {
      connection,
      validatedProducts: [],
      message: "Shopee belum authorized atau token expired. Hubungkan ulang seller."
    };
  }

  try {
    const keywordPool = buildKeywordPool(shorts, keywords);
    const performance = await getCachedPerformance();
    const products = rankShopeeProducts({
      products: performance.items || [],
      shorts,
      keywords: keywordPool,
      limit
    });

    shopeeApiLog("live_validation_success", {
      keywords: keywordPool.slice(0, 8),
      sourceProducts: performance.items?.length || 0,
      validatedProducts: products.length,
      cached: Boolean(performance.cached)
    });

    return {
      connection,
      keywords: keywordPool,
      validatedProducts: products,
      message: products.length ? "Validasi Shopee live selesai." : "Belum ada produk Shopee yang cocok dengan keyword viral."
    };
  } catch (error) {
    shopeeApiLog("live_validation_error", {
      error: error.message,
      code: error.code || "",
      status: error.status || ""
    });
    return {
      connection,
      validatedProducts: [],
      message: normalizeShopeeLiveError(error),
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    };
  }
}

async function getCachedPerformance() {
  if (performanceCache && Date.now() - performanceCache.createdAt < LIVE_CACHE_TTL_MS) {
    return { ...performanceCache.data, cached: true };
  }

  const data = await getAmsProductPerformance({ page_no: 1, page_size: 100 });
  performanceCache = {
    createdAt: Date.now(),
    data
  };
  return data;
}

function rankShopeeProducts({ products, shorts, keywords, limit }) {
  const keywordText = keywords.join(" ");
  const competitionByKeyword = buildCompetitionMap(products, keywords);
  return (products || [])
    .map((product) => {
      const matchedShort = findBestShort(product, shorts);
      const bestKeyword = pickBestKeyword(product, keywords);
      const relevance = Math.max(
        keywordRelevance(product.name || product.item_name || "", keywordText),
        bestKeyword.relevance,
        matchedShort.relevance
      );
      const score = scoreShopeeOpportunity({
        product,
        matchedShort: matchedShort.short,
        relevance,
        competition: competitionByKeyword.get(bestKeyword.keyword) || 1
      });
      return normalizeValidatedProduct({
        product,
        matchedShort: matchedShort.short,
        matchedKeyword: bestKeyword.keyword,
        relevance,
        score
      });
    })
    .filter((item) => item.relevance >= 0.08 || item.items_sold > 0 || item.orders > 0 || item.clicks > 0)
    .sort((a, b) => b.opportunityScore - a.opportunityScore || b.items_sold - a.items_sold || b.clicks - a.clicks)
    .slice(0, limit);
}

function normalizeValidatedProduct({ product, matchedShort, matchedKeyword, relevance, score }) {
  const opportunityScore = Math.max(0, Math.min(100, Math.round(score.total)));
  return {
    source: "shopee-live",
    item_id: product.item_id,
    name: product.name || product.item_name || "Produk Shopee",
    item_name: product.item_name || product.name || "Produk Shopee",
    image: product.image || "",
    url: product.url || "",
    sales: Number(product.sales || 0),
    items_sold: Number(product.items_sold || product.soldCount || 0),
    soldCount: Number(product.items_sold || product.soldCount || 0),
    orders: Number(product.orders || 0),
    clicks: Number(product.clicks || 0),
    roi: Number(product.roi || 0),
    rating: Number(product.rating || 0),
    reviewCount: Number(product.reviewCount || product.total_buyers || 0),
    total_buyers: Number(product.total_buyers || 0),
    new_buyers: Number(product.new_buyers || 0),
    est_commission: Number(product.est_commission || 0),
    matchedKeyword,
    matchedShort,
    matchedShortTitle: matchedShort?.title || "",
    relevance,
    score: opportunityScore,
    chance: opportunityScore,
    opportunityScore,
    label: opportunityScore >= 85 ? "HOT" : opportunityScore >= 70 ? "POTENSIAL" : opportunityScore >= 50 ? "MENARIK" : "LOW",
    validationStatus: "validated",
    validationReason: buildValidationReason({ product, matchedShort, matchedKeyword, score }),
    scoringBreakdown: score.breakdown
  };
}

function scoreShopeeOpportunity({ product, matchedShort, relevance, competition }) {
  const youtubeMomentum = Number(matchedShort?.momentum_score || matchedShort?.trend_score_final || matchedShort?.product_confidence || matchedShort?.score || 0);
  const soldScore = normalizeSold(product.items_sold || product.soldCount || 0) * 100;
  const ratingScore = product.rating ? normalizeRating(product.rating) * 100 : Math.min(100, Number(product.roi || 0) * 12);
  const reviewScore = normalizeReview(product.reviewCount || product.total_buyers || product.new_buyers || 0) * 100;
  const competitionScore = Math.max(20, 100 - Math.min(80, Math.log10(Math.max(competition, 1)) * 35));
  const affiliatePotential = Math.min(100, normalizeSold(product.orders || 0) * 35 + normalizeSold(product.clicks || 0) * 25 + Math.min(40, Number(product.roi || 0) * 8));
  const relevanceScore = Math.min(100, relevance * 120);
  const total = youtubeMomentum * 0.3
    + soldScore * 0.22
    + ratingScore * 0.12
    + reviewScore * 0.08
    + competitionScore * 0.1
    + affiliatePotential * 0.13
    + relevanceScore * 0.05;

  return {
    total,
    breakdown: {
      youtubeMomentum: Math.round(youtubeMomentum),
      shopeeDemand: Math.round(soldScore),
      shopeeCompetition: Math.round(competitionScore),
      shopeeRating: Math.round(ratingScore),
      reviewSignal: Math.round(reviewScore),
      affiliatePotential: Math.round(affiliatePotential),
      relevance: Math.round(relevanceScore)
    }
  };
}

function buildKeywordPool(shorts, keywords) {
  return dedupeStrings(
    (keywords || [])
      .concat((shorts || []).flatMap((item) => item.extractedKeywords || extractProductKeywords(item.title)))
      .concat((shorts || []).map((item) => item.estimated_product_type))
  ).slice(0, 12);
}

function findBestShort(product, shorts) {
  return (shorts || [])
    .map((short) => ({
      short,
      relevance: Math.max(
        keywordRelevance(product.name || product.item_name || "", short.title || ""),
        ...(short.extractedKeywords || []).map((keyword) => keywordRelevance(product.name || product.item_name || "", keyword))
      )
    }))
    .sort((a, b) => b.relevance - a.relevance)[0] || { short: null, relevance: 0 };
}

function pickBestKeyword(product, keywords) {
  return (keywords || [])
    .map((keyword) => ({ keyword, relevance: keywordRelevance(product.name || product.item_name || "", keyword) }))
    .sort((a, b) => b.relevance - a.relevance)[0] || { keyword: "", relevance: 0 };
}

function buildCompetitionMap(products, keywords) {
  const map = new Map();
  (keywords || []).forEach((keyword) => {
    const count = (products || []).filter((product) => keywordRelevance(product.name || product.item_name || "", keyword) >= 0.08).length;
    map.set(keyword, Math.max(1, count));
  });
  return map;
}

function buildValidationReason({ product, matchedShort, matchedKeyword, score }) {
  const parts = [];
  if (matchedKeyword) parts.push(`match keyword ${matchedKeyword}`);
  if (matchedShort?.title) parts.push("terhubung dengan trend Shorts");
  if (Number(product.items_sold || 0) > 0) parts.push(`${formatCompact(product.items_sold)} terjual`);
  if (Number(product.orders || 0) > 0) parts.push(`${formatCompact(product.orders)} order`);
  if (Number(product.clicks || 0) > 0) parts.push(`${formatCompact(product.clicks)} klik`);
  if (Number(product.roi || 0) > 0) parts.push(`${Number(product.roi).toFixed(1)} ROI`);
  if (score.breakdown?.affiliatePotential >= 60) parts.push("potensi affiliate kuat");
  return parts.join(" | ") || "Produk cocok untuk divalidasi dari data Shopee live.";
}

function normalizeShopeeLiveError(error) {
  if (error.code === "SHOPEE_TOKEN_EXPIRED") return "Token Shopee expired. Hubungkan ulang seller.";
  if (error.code === "SHOPEE_NOT_AUTHORIZED") return "Shopee belum authorized. Buka /api/shopee/auth-url.";
  if (error.code === "SHOPEE_OPEN_NOT_CONFIGURED") return "Shopee Open Platform belum dikonfigurasi.";
  return "Shopee live validation belum tersedia.";
}

function buildConnectionMessage(status) {
  if (!status.configured) return "Shopee Open Platform belum dikonfigurasi.";
  if (!status.authorized) return "Shopee belum authorized. Buka /api/shopee/auth-url.";
  if (status.tokenExpired) return "Token Shopee expired. Hubungkan ulang seller.";
  return "Seller Shopee tersambung.";
}

function dedupeStrings(items) {
  const seen = new Set();
  return items
    .map((item) => String(item || "").toLowerCase().replace(/\s+/g, " ").trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function formatCompact(value) {
  return new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

module.exports = {
  getSellerConnectionDashboard,
  validateShopeeProducts
};
