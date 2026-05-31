const { getCategoryKeywords } = require("../services/categories");
const { buildOpportunities, fetchYouTubeShortsIndonesia } = require("../services/shortsResearch");
const { labelScore } = require("../services/scoring");
const { getAmsProductsFromRequest } = require("../services/shopeeServerlessAms");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = await readJsonBody(req);
    const mode = normalizeMode(body.mode);
    const keyword = cleanText(body.keyword);
    const category = cleanText(body.category);
    const resolvedKeyword = resolveKeyword({ mode, keyword, category });

    if (mode === "manual" && !keyword) return res.status(400).json({ ok: false, error: "Keyword wajib diisi." });
    if (mode === "category" && !category) return res.status(400).json({ ok: false, error: "Kategori wajib dipilih." });

    const shortsResult = await fetchYouTubeShortsIndonesia({
      keyword: resolvedKeyword,
      limit: mode === "auto" ? 20 : 15,
      days: 30,
      fetchYouTubeTrends,
      maxKeywords: mode === "category" ? 2 : 1
    });
    const shorts = shortsResult.items || [];
    const amsResult = await getAmsProductsFromRequest(req, {
      page_no: 1,
      page_size: 10,
      query: resolvedKeyword,
      category: mode === "category" ? category : ""
    });
    if (amsResult.setCookies) res.setHeader("Set-Cookie", amsResult.setCookies);
    const shopeeFilter = filterProductsByResearch(amsResult.items || [], {
      mode,
      keyword,
      category,
      resolvedKeyword
    });
    const products = shopeeFilter.items;
    const opportunities = buildOpportunities(shorts, products);
    const shopeeStats = buildShopeeStats(products);
    const shopeeMessage = products.length
      ? "Shopee Ready."
      : shopeeFilter.rawCount
        ? "Tidak ada produk Shopee relevan untuk kategori ini"
        : amsResult.message || amsResult.error || "Shopee belum mengambil data trends.";

    return res.status(200).json({
      ok: true,
      mode,
      keyword: mode === "manual" ? keyword : "",
      category: mode === "category" ? category : "",
      shorts,
      products,
      shopee: products,
      opportunities,
      keywordRecommendations: shortsResult.keywordRecommendations || [],
      topKeywordTurunan: shortsResult.topKeywordTurunan || [],
      topProductAngles: shortsResult.topProductAngles || [],
      stats: {
        ...(shortsResult.stats || {}),
        shopee: shopeeStats
      },
      shopeeStats,
      shopeeStatus: {
        ready: Boolean(amsResult.ok),
        message: shopeeMessage,
        tokenSource: amsResult.tokenSource || "",
        shopId: amsResult.shopId || null,
        rawItemCount: amsResult.rawItemCount || 0,
        mappedItemCount: amsResult.mappedItemCount || 0,
        relevantItemCount: products.length,
        fallbackSearchUrl: shopeeFilter.fallbackSearchUrl
      },
      debug: {
        youtube: [shortsResult.debug || {}],
        shopee: {
          ok: Boolean(amsResult.ok),
          shopee_query: shopeeFilter.query,
          shopee_raw_count: shopeeFilter.rawCount,
          shopee_relevant_count: shopeeFilter.relevantCount,
          filtered_out_reason: shopeeFilter.filteredOutReason,
          fallback_search_url: shopeeFilter.fallbackSearchUrl,
          terms: shopeeFilter.terms,
          tokenSource: amsResult.tokenSource || "",
          shopId: amsResult.shopId || null,
          rawItemCount: amsResult.rawItemCount || 0,
          mappedItemCount: amsResult.mappedItemCount || 0,
          error: amsResult.error || null
        },
        serverless: true
      },
      message: `Riset selesai: ${shorts.length} video viral, ${products.length} trends Shopee AMS, ${opportunities.length} peluang. ${shopeeMessage}`
    });
  } catch (error) {
    console.error("[api/research] failed", {
      message: error.message,
      code: error.code,
      status: error.status,
      requestUrl: error.requestUrl
    });
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Riset gagal.",
      code: error.code || "RESEARCH_FAILED",
      detail: error.response || undefined,
      requestUrl: error.requestUrl || undefined
    });
  }
};

async function fetchYouTubeTrends({ niche, days, limit, shorts = false, regionCode = "ID" }) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    const error = new Error("YouTube API key belum dikonfigurasi");
    error.code = "YOUTUBE_API_KEY_MISSING";
    error.status = 400;
    throw error;
  }

  const maxResults = shorts ? 25 : limit;
  const publishedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.search = new URLSearchParams({
    key,
    part: "snippet",
    type: "video",
    q: shorts ? niche : `${niche} review OR find OR haul OR product`,
    order: shorts ? (niche ? "relevance" : "viewCount") : "viewCount",
    regionCode,
    relevanceLanguage: "id",
    hl: "id",
    maxResults: String(maxResults),
    publishedAfter
  });

  const searchData = await fetchUpstreamJson(searchUrl);
  const ids = (searchData.items || []).map((item) => item.id && item.id.videoId).filter(Boolean);
  if (!ids.length) return { platform: "youtube", configured: true, items: [] };

  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.search = new URLSearchParams({
    key,
    part: "snippet,statistics,contentDetails",
    hl: "id",
    id: ids.join(",")
  });

  const videoData = await fetchUpstreamJson(videosUrl);
  const normalizedItems = (videoData.items || []).map(normalizeYouTubeVideo);
  const items = normalizeViralScores(normalizedItems)
    .sort((a, b) => b.viral_score - a.viral_score || b.views - a.views);

  return {
    platform: "youtube",
    configured: true,
    query: niche,
    since: publishedAfter,
    debug: {
      rawCount: normalizedItems.length,
      filteredCount: normalizedItems.length,
      finalCount: items.length
    },
    items
  };
}

async function fetchUpstreamJson(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.error("[api/research] upstream fetch failed", { url: redactApiKey(String(url)), error: error.message });
    const wrapped = new Error(`YouTube API request gagal: ${error.message}`);
    wrapped.status = 502;
    wrapped.requestUrl = redactApiKey(String(url));
    throw wrapped;
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    console.error("[api/research] upstream non-json", {
      url: redactApiKey(String(url)),
      status: response.status,
      contentType,
      bodyPreview: text.slice(0, 250)
    });
    const wrapped = new Error("YouTube API mengirim response bukan JSON.");
    wrapped.status = 502;
    throw wrapped;
  }

  if (!response.ok) {
    console.error("[api/research] upstream error", {
      url: redactApiKey(String(url)),
      status: response.status,
      data
    });
    const error = new Error(data.error?.message || `YouTube API request gagal (${response.status})`);
    error.status = response.status;
    error.response = data;
    error.requestUrl = redactApiKey(String(url));
    if (/quotaExceeded|dailyLimitExceeded|quota/i.test(JSON.stringify(data))) {
      error.code = "YOUTUBE_QUOTA_EXCEEDED";
      error.message = "Quota YouTube API habis, ganti API key atau tunggu reset.";
    }
    throw error;
  }

  return data;
}

function normalizeYouTubeVideo(item) {
  const stats = item.statistics || {};
  const snippet = item.snippet || {};
  const views = Number(stats.viewCount || 0);
  const likes = Number(stats.likeCount || 0);
  const comments = Number(stats.commentCount || 0);
  const publishedAt = snippet.publishedAt || new Date().toISOString();
  const ageHours = Math.max(1, (Date.now() - new Date(publishedAt).getTime()) / 36e5);
  const engagementRate = views ? (likes + comments * 2) / views : 0;
  const durationSeconds = parseDurationSeconds(item.contentDetails?.duration || "");
  const isShort = durationSeconds > 0 && durationSeconds < 90;
  const viralRaw = views * 0.5 + likes * 0.3 + comments * 0.2;

  return {
    id: item.id,
    title: snippet.title || "Untitled video",
    channel: snippet.channelTitle || "Unknown channel",
    publishedAt,
    uploadDate: publishedAt,
    url: isShort ? `https://www.youtube.com/shorts/${item.id}` : `https://www.youtube.com/watch?v=${item.id}`,
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
    views,
    likes,
    comments,
    durationSeconds,
    isShort,
    velocity: Math.round(views / ageHours),
    engagementRate,
    viralRaw,
    viral_score: 0,
    score: 0,
    label: "LOW"
  };
}

function normalizeViralScores(items) {
  const max = Math.max(...items.map((item) => Number(item.viralRaw || 0)), 1);
  return items.map((item) => {
    const score = Math.round((Number(item.viralRaw || 0) / max) * 100);
    return { ...item, viral_score: score, score, label: labelScore(score) };
  });
}

function parseDurationSeconds(duration) {
  const match = String(duration || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function resolveKeyword({ mode, keyword, category }) {
  if (mode === "auto") return "produk viral indonesia";
  if (mode === "category") return getCategoryKeywords(category)[0] || category;
  return keyword;
}

function normalizeMode(mode) {
  if (mode === "category") return "category";
  if (mode === "manual" || mode === "keyword") return "manual";
  return "auto";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function filterProductsByResearch(products, context = {}) {
  const query = buildShopeeQuery(context);
  const terms = buildShopeeTerms(context);
  const negativeTerms = buildNegativeTerms(context.category);
  const fallbackSearchUrl = `https://shopee.co.id/search?keyword=${encodeURIComponent(query)}`;
  const decisions = (products || []).map((product) => {
    const text = normalizeForMatch(`${product.item_name || ""} ${product.name || ""} ${product.shop_name || ""} ${product.shopName || ""}`);
    const negativeMatches = negativeTerms.filter((term) => text.includes(term));
    const positiveMatches = terms.filter((term) => text.includes(term));
    const relevant = positiveMatches.length > 0 && negativeMatches.length === 0;
    return {
      product,
      relevant,
      reason: relevant
        ? `matched:${positiveMatches.slice(0, 3).join("|")}`
        : negativeMatches.length
          ? `rejected_negative:${negativeMatches.slice(0, 3).join("|")}`
          : "no_keyword_or_category_match"
    };
  });
  const items = decisions.filter((item) => item.relevant).map((item) => ({
    ...item.product,
    matched_query: query,
    fallback_search_url: item.product.fallback_search_url || fallbackSearchUrl
  }));
  const filtered = decisions.filter((item) => !item.relevant);
  return {
    items,
    query,
    terms,
    rawCount: products.length,
    relevantCount: items.length,
    fallbackSearchUrl,
    filteredOutReason: filtered.slice(0, 10).map((item) => ({
      item_id: item.product.item_id || "",
      item_name: item.product.item_name || item.product.name || "",
      reason: item.reason
    }))
  };
}

function buildShopeeQuery({ mode, keyword, category, resolvedKeyword }) {
  if (mode === "category" && category) return category;
  return cleanText(keyword || resolvedKeyword || "produk viral indonesia");
}

function buildShopeeTerms({ mode, keyword, category, resolvedKeyword }) {
  const raw = [
    keyword,
    resolvedKeyword,
    mode === "category" ? category : "",
    ...(mode === "category" ? getCategoryKeywords(category) : [])
  ].filter(Boolean);
  const expanded = raw.flatMap((value) => expandShopeeTerm(value));
  return [...new Set(expanded.map(normalizeForMatch).filter((term) => term.length > 2 && !GENERIC_MATCH_TERMS.has(term)))];
}

function expandShopeeTerm(value) {
  const text = cleanText(value).toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const terms = [text, ...words];
  const synonymGroups = [
    ["dapur", "masak", "kitchen", "panci", "wajan", "spatula", "pisau", "sendok", "rak dapur", "kompor", "gelas", "botol", "mangkuk"],
    ["bayi", "baby", "anak", "kids", "balita", "mainan", "stroller", "botol susu", "popok", "makan bayi"],
    ["rumah", "pembersih", "pel", "sapu", "rak", "storage", "organizer", "hanger", "dekorasi"],
    ["fashion wanita", "wanita", "dress", "gamis", "rok", "tas wanita", "heels", "blouse"],
    ["fashion pria", "pria", "cowok", "kaos", "kemeja", "celana", "sepatu", "boxer"],
    ["gadget", "charger", "case", "holder", "earphone", "powerbank", "stand hp", "aksesoris hp"]
  ];
  synonymGroups.forEach((group) => {
    if (group.some((term) => text.includes(term))) terms.push(...group);
  });
  return terms;
}

function buildNegativeTerms(category) {
  const key = cleanText(category).toLowerCase();
  if (!key) return [];
  const fashionTerms = ["boxer", "celana", "baju", "kaos", "kemeja", "dress", "gamis", "rok", "bra", "pakaian", "fashion", "outfit"];
  if (key.includes("dapur") || key.includes("rumah") || key.includes("baby") || key.includes("kids")) return fashionTerms;
  if (key.includes("fashion")) return ["panci", "wajan", "pisau", "spatula", "sapu", "pel", "popok", "botol susu"];
  return [];
}

function normalizeForMatch(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_MATCH_TERMS = new Set(["alat", "produk", "viral", "murah", "terlaris", "perlengkapan", "rekomendasi", "shop", "shopee"]);

function buildShopeeStats(products) {
  const count = products.length;
  const avgCommission = count
    ? Math.round((products.reduce((sum, item) => sum + Number(item.commission_rate || 0), 0) / count) * 100) / 100
    : 0;
  const top = [...products].sort((a, b) => Number(b.commission_rate || 0) - Number(a.commission_rate || 0))[0] || null;
  return {
    productCount: count,
    averageCommissionRate: avgCommission,
    topCommissionProduct: top ? {
      item_id: top.item_id,
      item_name: top.item_name || top.name,
      commission_rate: top.commission_rate || 0,
      image_url: top.image_url || top.image || "",
      price: top.price || "",
      shop_name: top.shop_name || top.shopName || "",
      url: top.url || ""
    } : null
  };
}

function redactApiKey(url) {
  return String(url).replace(/key=[^&]+/g, "key=REDACTED");
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
