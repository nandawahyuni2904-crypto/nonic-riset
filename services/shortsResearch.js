const { keywordRelevance, normalizeRating, normalizeReview, normalizeSold, opportunityLabel } = require("./scoring");
const { extractProductKeywords } = require("./keywordExtraction");
const { getCache, setCache } = require("./cacheStore");

const PRODUCT_INTENT_WORDS = [
  "viral", "shopee", "tiktok shop", "racun", "beli", "murah", "aesthetic", "rekomendasi",
  "unik", "amazon find", "haul", "review", "kitchen", "gadget", "peralatan", "dekorasi",
  "skincare", "fashion", "produk", "jualan", "terlaris", "kekinian", "promo", "diskon",
  "unboxing", "viral shop", "multifungsi", "portable"
];
const REJECT_WORDS = [
  "prank", "meme", "kucing", "gameplay", "reaction", "anime", "musik", "karaoke",
  "siram", "challenge", "story", "vlog", "komedi", "comedy", "lucu", "ngakak",
  "eksperimen", "rusak", "air panas", "random"
];
const STOP_WORDS = new Set([
  "yang", "dan", "untuk", "dengan", "dari", "pakai", "pake", "ini", "itu", "aku", "kamu",
  "shorts", "short", "video", "viral", "fyp", "banget", "bikin", "cara", "jadi", "cuma",
  "ada", "bisa", "wajib", "punya", "terbaru", "terbaik", "murah", "aja", "nih", "dong",
  "deh", "sih", "kok", "kan", "lagi", "buat", "dalam", "karena", "kalau", "kalo", "sama",
  "udah", "sudah", "belum", "akan", "atau", "para", "jadi", "dapet", "dapat", "lihat",
  "nonton", "part", "full", "episode", "pengantin", "artis", "seleb", "subtitle"
]);
const PUBLIC_FIGURE_BLACKLIST = [
  "amanda", "manopo", "amanda manopo", "soimah", "raffi", "ahmad", "nagita", "ayu ting ting",
  "lesti", "kejora", "rizky billar", "attahalilintar", "atta", "aurel", "fuji", "thariq",
  "ruben", "sarwendah", "bunga citra", "luna maya", "nikita", "mirzani", "rian", "deddy",
  "corbuzier", "najwa", "shihab", "baim", "paula"
];
const PRODUCT_KEYWORD_WHITELIST = [
  "gelas", "botol", "tumbler", "rak", "organizer", "tas", "dompet", "sepatu", "baju",
  "celana", "lampu", "charger", "case", "stand", "holder", "alat", "dapur", "skincare",
  "serum", "sunscreen", "parfum", "makeup", "gadget", "dekorasi", "aksesoris", "portable",
  "multifungsi", "aesthetic", "unik", "shopee", "tiktok shop", "racun", "review", "unboxing",
  "rekomendasi", "murah", "viral"
];
const PRODUCT_ANGLES = ["aesthetic", "multifungsi", "portable", "murah", "viral tiktok", "unik", "review", "unboxing"];

async function fetchYouTubeShortsIndonesia({ keyword = "", limit = 20, days = 30, fetchYouTubeTrends, maxKeywords = 2 }) {
  const target = Math.min(Math.max(limit, 20), 25);
  const queries = buildShortsQueries(keyword).slice(0, Math.max(1, maxKeywords));
  const cacheKey = `shorts:${String(keyword || "auto").toLowerCase()}:${target}:${days}:${queries.join("|")}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const debug = {
    keyword: String(keyword || ""),
    expandedKeywords: queries,
    rawCount: 0,
    filteredCount: 0,
    scoredCount: 0,
    finalCount: 0,
    errors: []
  };
  let firstResults;
  try {
    firstResults = await runShortsQueries(queries, { days, target, fetchYouTubeTrends });
  } catch (error) {
    if (error.code === "YOUTUBE_QUOTA_EXCEEDED") {
      const expired = getCache(cacheKey, { allowExpired: true });
      if (expired) return { ...expired, fromCache: true, quotaFallback: true };
    }
    throw error;
  }
  debug.errors.push(...firstResults.flatMap((data) => data.errors || []));
  let rawItems = firstResults.flatMap((data) => data.items || []);
  let items = dedupeSimilarShorts(dedupeShorts(rawItems));
  debug.rawCount = sumDebugCount(firstResults, "rawCount", rawItems.length);
  debug.filteredCount = sumDebugCount(firstResults, "filteredCount", items.length);

  if (!rawItems.length && debug.errors.length) {
    const error = new Error(debug.errors[0] || "YouTube API request gagal");
    error.debug = debug;
    throw error;
  }

  const scoredItems = normalizeCombinedViralScores(items)
    .map((item) => addProductRelevance(item, keyword))
    .filter((item) => item.rejected_intent_hits === 0)
    .sort((a, b) => b.product_confidence - a.product_confidence || b.engagementRate - a.engagementRate || b.views - a.views);
  debug.scoredCount = scoredItems.length;

  items = scoredItems
    .filter((item) => item.product_confidence >= 30)
    .slice(0, target);

  if (items.length < Math.min(10, target) && scoredItems.length) {
    const pool = scoredItems.filter((item) => item.product_confidence > 0 || !hasNonProductNoise(item.title));
    items = dedupeSimilarShorts(dedupeShorts(items.concat(pool.slice(0, Math.min(20, target))))).slice(0, target);
  }

  if (!items.length && rawItems.length) {
    items = normalizeCombinedViralScores(dedupeSimilarShorts(dedupeShorts(rawItems)))
      .map((item) => addProductRelevance(item, keyword))
      .filter((item) => item.rejected_intent_hits === 0)
      .sort((a, b) => b.product_confidence - a.product_confidence || b.engagementRate - a.engagementRate || b.views - a.views)
      .slice(0, Math.min(20, target));
    debug.usedRawFallback = true;
  }
  const keywordRecommendations = buildKeywordRecommendations(items, keyword);
  const stats = buildShortsStats(items, keywordRecommendations);

  debug.finalCount = items.length;
  console.log(`[shorts] keyword="${debug.keyword}" expanded=${queries.length} raw=${debug.rawCount} filtered=${debug.filteredCount} scored=${debug.scoredCount} final=${debug.finalCount}`);
  if (debug.errors.length) console.warn(`[shorts] errors: ${debug.errors.join(" | ")}`);

  const result = {
    platform: "youtube-shorts-id",
    configured: true,
    query: queries[0],
    keywords: queries,
    keywordRecommendations,
    topKeywordTurunan: buildTopKeywordTurunan(keywordRecommendations, keyword),
    topProductAngles: buildTopProductAngles(items),
    stats,
    debug,
    items: items.map((item) => ({
      ...item,
      source: "youtube-shorts",
      extractedKeywords: item.important_keywords || extractProductKeywords(item.title, keyword)
    }))
  };
  return setCache(cacheKey, keyword || "auto", result);
}

async function runShortsQueries(queries, { days, target, fetchYouTubeTrends }) {
  return Promise.all(queries.map(async (query) => {
    try {
      const data = await fetchYouTubeTrends({
        niche: query,
        days,
        limit: target,
        shorts: true,
        regionCode: "ID"
      });
      console.log(`[shorts] query="${query}" raw=${data.debug?.rawCount ?? (data.items || []).length} filtered=${data.debug?.filteredCount ?? (data.items || []).length} final=${(data.items || []).length}`);
      return data;
    } catch (error) {
      if (error.code === "YOUTUBE_API_KEY_MISSING") throw error;
      if (isQuotaError(error)) throw normalizeQuotaError(error);
      console.warn(`[shorts] query="${query}" error=${error.message}`);
      return {
        platform: "youtube-shorts-id",
        configured: true,
        query,
        items: [],
        errors: [`${query}: ${error.message}`],
        message: error.message
      };
    }
  }));
}

function isQuotaError(error) {
  if (error.code === "YOUTUBE_QUOTA_EXCEEDED") return true;
  const text = JSON.stringify(error.response || {}) + " " + String(error.message || "");
  return /quotaExceeded|quota|dailyLimitExceeded/i.test(text);
}

function normalizeQuotaError(error) {
  const quotaError = new Error("Quota YouTube API habis, ganti API key atau tunggu reset.");
  quotaError.code = "YOUTUBE_QUOTA_EXCEEDED";
  quotaError.response = error.response;
  quotaError.requestUrl = error.requestUrl;
  return quotaError;
}

function sumDebugCount(results, key, fallback) {
  const values = results.map((data) => Number(data.debug?.[key])).filter(Number.isFinite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : fallback;
}

function buildShortsQueries(keyword) {
  const clean = String(keyword || "").trim();
  const base = clean || "produk viral";
  return dedupeStrings([
    base,
    `${base} viral`,
    `${base} review`,
    `${base} aesthetic`,
    `${base} unik`,
    `${base} shopee`,
    `${base} tiktok`,
    `${base} tiktok shop`,
    `${base} portable`,
    `${base} kekinian`,
    `rekomendasi ${base}`,
    `racun ${base}`,
    `review ${base}`,
    `unboxing ${base}`,
    `${base} shorts indonesia`,
    `${base} terbaru`
  ]);
}

function dedupeShorts(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id || item.url || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSimilarShorts(items) {
  const seen = [];
  return items.filter((item) => {
    const signature = titleSignature(item.title);
    if (!signature) return true;
    const duplicate = seen.some((existing) => similarity(signature, existing) >= 0.72);
    if (!duplicate) seen.push(signature);
    return !duplicate;
  });
}

function dedupeStrings(items) {
  return items.map((item) => item.trim()).filter((item, index, array) => item && array.indexOf(item) === index);
}

function normalizeCombinedViralScores(items) {
  const max = Math.max(...items.map((item) => Number(item.viralRaw || 0)), 1);
  return items.map((item) => ({
    ...item,
    viral_score: Math.round((Number(item.viralRaw || 0) / max) * 100),
    score: Math.round((Number(item.viralRaw || 0) / max) * 100)
  }));
}

function addProductRelevance(item, keyword) {
  const title = String(item.title || "").toLowerCase();
  const baseKeyword = String(keyword || "").toLowerCase().trim();
  const keywordWords = baseKeyword.split(/\s+/).filter(Boolean);
  const matchedWords = keywordWords.filter((word) => title.includes(word)).length;
  const keywordMatch = keywordWords.length ? matchedWords / keywordWords.length : 0.4;
  const exactBonus = baseKeyword && title.includes(baseKeyword) ? 0.25 : 0;
  const intentHits = PRODUCT_INTENT_WORDS.filter((word) => title.includes(word)).length;
  const rejectHits = REJECT_WORDS.filter((word) => title.includes(word)).length;
  const strongIntent = /(shopee|tiktok shop|review|unboxing|rekomendasi|racun|aesthetic|portable|multifungsi|murah|beli|viral shop)/i.test(title) ? 1 : 0;
  const productIntent = Math.min(1, intentHits / 2.5 + strongIntent * 0.25);
  const engagement = Number(item.viral_score || 0) / 100;
  const engagementRate = Number(item.engagementRate || 0);
  const engagementBoost = Math.min(1, engagementRate * 80);
  const publicFigurePenalty = PUBLIC_FIGURE_BLACKLIST.some((name) => title.includes(name)) ? 35 : 0;
  const rawScore = keywordMatch * 35 + exactBonus * 10 + productIntent * 35 + engagement * 12 + engagementBoost * 8 - rejectHits * 35 - publicFigurePenalty;
  const sellable = keywordMatch > 0 && intentHits > 0 && rejectHits === 0;
  const productScore = Math.max(0, Math.min(100, Math.round(rawScore)));
  const importantKeywords = extractImportantKeywords(item.title, keyword);
  const estimatedProductType = estimateProductType(importantKeywords, item.title, keyword);
  const confidenceLabel = productScore >= 80 ? "HOT" : productScore >= 60 ? "GOOD" : "LOW";
  const trendScoreFinal = scoreTrendFinal({ confidence: productScore, engagementRate, views: item.views, velocity: item.velocity });
  const niche = detectNiche(`${item.title} ${estimatedProductType}`);
  const targetAudience = estimateTargetAudience(`${item.title} ${estimatedProductType}`, niche);

  return {
    ...item,
    product_intent_hits: intentHits,
    rejected_intent_hits: rejectHits,
    product_score: productScore,
    product_confidence: productScore,
    confidence_label: confidenceLabel,
    label: confidenceLabel,
    trend_score_final: trendScoreFinal,
    virality_level: trendScoreFinal >= 80 ? "Exploding" : trendScoreFinal >= 55 ? "Rising" : "Stable",
    estimated_selling_power: Math.max(0, Math.min(100, Math.round(productScore * 0.72 + trendScoreFinal * 0.28))),
    estimated_product_type: estimatedProductType,
    auto_niche: niche,
    target_audience: targetAudience,
    cta_recommendation: buildCtaRecommendation(`${item.title} ${estimatedProductType}`, productScore),
    related_product_recommendation: buildRelatedProducts(estimatedProductType, importantKeywords),
    why_viral: buildWhyViral({ title: item.title, importantKeywords, productScore, engagementRate, views: item.views }),
    important_keywords: importantKeywords,
    sellable_product_signal: sellable
  };
}

function scoreTrendFinal({ confidence, engagementRate, views, velocity }) {
  const viewScore = Math.min(100, Math.log10(Math.max(Number(views || 0), 1)) / 7 * 100);
  const engagementScore = Math.min(100, Number(engagementRate || 0) * 900);
  const velocityScore = Math.min(100, Math.log10(Math.max(Number(velocity || 0), 1)) / 5 * 100);
  return Math.max(0, Math.min(100, Math.round(confidence * 0.45 + engagementScore * 0.3 + velocityScore * 0.15 + viewScore * 0.1)));
}

function extractImportantKeywords(title, keyword = "") {
  const cleanedTitle = cleanKeywordText(title);
  const words = tokenize(`${keyword} ${cleanedTitle}`)
    .filter(isUsefulKeywordWord);
  const phrases = [];
  const base = cleanKeywordText(keyword);
  const titleLower = cleanedTitle;
  ["aesthetic", "portable", "multifungsi", "unik", "shopee", "tiktok shop", "review", "unboxing", "racun"].forEach((modifier) => {
    if (base && titleLower.includes(modifier)) phrases.push(`${base} ${modifier}`);
  });
  for (let i = 0; i < words.length - 1; i += 1) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    if (words[i] !== words[i + 1] && hasProductSignal(phrase)) phrases.push(phrase);
  }
  return dedupeStrings(phrases.concat(words).map(cleanKeywordText))
    .filter(isUsefulKeywordPhrase)
    .sort((a, b) => scoreKeywordPhrase(b, base) - scoreKeywordPhrase(a, base))
    .slice(0, 8);
}

function estimateProductType(keywords, title, fallback = "") {
  const text = `${keywords.join(" ")} ${title} ${fallback}`.toLowerCase();
  const known = [
    "gelas aesthetic", "botol minum", "rak sepatu", "skincare", "fashion wanita",
    "fashion pria", "tas wanita", "dompet wanita", "alat dapur", "gadget portable",
    "dekorasi rumah", "peralatan kantor", "peralatan sekolah"
  ];
  const found = known.find((item) => text.includes(item));
  if (found) return found;
  const firstPhrase = keywords.find((item) => item.split(" ").length >= 2);
  return firstPhrase || keywords[0] || fallback || "produk viral";
}

function buildKeywordRecommendations(items, keyword = "") {
  const counts = new Map();
  items.flatMap((item) => item.important_keywords || []).forEach((item) => {
    if (!isUsefulKeywordPhrase(item)) return;
    counts.set(item, (counts.get(item) || 0) + 1);
  });
  const base = cleanKeywordText(keyword);
  const fallback = base ? [
    `${base} aesthetic`,
    `${base} portable`,
    `${base} viral shopee`,
    `${base} unik`,
    `${base} multifungsi`
  ] : [];
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] * 10 + scoreKeywordPhrase(b[0], base)) - (a[1] * 10 + scoreKeywordPhrase(a[0], base)))
    .map(([item]) => item)
    .concat(fallback)
    .map(cleanKeywordText)
    .filter(isUsefulKeywordPhrase)
    .filter((item, index, array) => array.indexOf(item) === index)
    .slice(0, 8);
}

function buildTopKeywordTurunan(recommendations, keyword = "") {
  const base = cleanKeywordText(keyword);
  const fallback = base ? [`${base} aesthetic`, `${base} portable`, `${base} viral`, `${base} unik`, `${base} shopee`] : [];
  return dedupeStrings((recommendations || []).concat(fallback).map(cleanKeywordText))
    .filter(isUsefulKeywordPhrase)
    .slice(0, 8);
}

function buildTopProductAngles(items) {
  const text = items.map((item) => `${item.title} ${(item.important_keywords || []).join(" ")}`).join(" ").toLowerCase();
  const found = PRODUCT_ANGLES.filter((angle) => text.includes(angle.replace("viral tiktok", "tiktok")) || text.includes(angle));
  return dedupeStrings(found.concat(["aesthetic", "multifungsi", "portable", "murah", "viral tiktok"])).slice(0, 6);
}

function detectNiche(text) {
  const value = String(text || "").toLowerCase();
  if (/skincare|serum|sunscreen|moisturizer|facial/.test(value)) return "skincare";
  if (/fashion|baju|celana|outfit|tas|dompet|sepatu|wanita|pria/.test(value)) return "fashion";
  if (/gadget|charger|earphone|hp|laptop|portable/.test(value)) return "gadget";
  if (/dekorasi|lampu|hiasan|kamar|rumah/.test(value)) return "dekorasi";
  if (/aksesoris|case|strap|jepit|gelang|kalung/.test(value)) return "aksesoris";
  return "rumah tangga";
}

function estimateTargetAudience(text, niche) {
  const value = String(text || "").toLowerCase();
  if (/wanita|cewek|skincare|makeup|tas|dompet/.test(value)) return "wanita";
  if (/pria|cowok|alat kerja|otomotif/.test(value)) return "pria";
  if (/sekolah|mahasiswa|kampus|stationery/.test(value)) return "anak sekolah";
  if (/dapur|rumah|cleaning|organizer/.test(value) || niche === "rumah tangga") return "ibu rumah tangga";
  return "remaja";
}

function buildCtaRecommendation(text, confidence) {
  const value = String(text || "").toLowerCase();
  if (/tiktok|racun|viral/.test(value)) return "Cocok untuk TikTok Shop";
  if (/shopee|murah|promo/.test(value)) return "Cocok untuk Shopee Affiliate";
  if (/review|unboxing/.test(value)) return "Cocok untuk konten review";
  if (confidence >= 75) return "Cocok untuk impulse buying";
  return "Cocok untuk konten edukasi produk";
}

function buildRelatedProducts(productType, keywords) {
  const text = `${productType} ${(keywords || []).join(" ")}`.toLowerCase();
  if (text.includes("gelas")) return ["sedotan stainless", "botol minum", "rak gelas", "sikat pembersih botol"];
  if (text.includes("rak sepatu")) return ["organizer lemari", "kotak sepatu", "rak serbaguna"];
  if (text.includes("skincare")) return ["headband skincare", "face roller", "kapas wajah"];
  if (text.includes("fashion")) return ["aksesoris outfit", "tas mini", "sepatu casual"];
  return [`${productType} murah`, `${productType} aesthetic`, `${productType} portable`].filter(Boolean);
}

function buildWhyViral({ title, importantKeywords, productScore, engagementRate, views }) {
  const reasons = [];
  const value = String(title || "").toLowerCase();
  if (productScore >= 80) reasons.push("sinyal produk sangat kuat");
  if (Number(views || 0) >= 100000) reasons.push("views tinggi");
  if (Number(engagementRate || 0) >= 0.04) reasons.push("engagement sehat");
  if (/aesthetic|unik|portable|multifungsi|murah/.test(value)) reasons.push("angle mudah dijual");
  if ((importantKeywords || []).length) reasons.push(`keyword utama: ${importantKeywords.slice(0, 2).join(", ")}`);
  return reasons.join(" | ") || "Judul mengandung sinyal produk yang relevan.";
}

function cleanKeywordText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s#]/gu, " ")
    .replace(/#(\w+)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulKeywordWord(word) {
  if (!word || word.length < 4) return false;
  if (/^\d+$/.test(word)) return false;
  if (STOP_WORDS.has(word)) return false;
  if (REJECT_WORDS.includes(word)) return false;
  if (PUBLIC_FIGURE_BLACKLIST.includes(word)) return false;
  return true;
}

function isUsefulKeywordPhrase(value) {
  const phrase = cleanKeywordText(value);
  if (!phrase || phrase.length < 5) return false;
  if (/^\d+(\s+\d+)*$/.test(phrase)) return false;
  if (/\b\d{2,}\b/.test(phrase)) return false;
  if (/(.)\s+\1$/.test(phrase)) return false;
  if (REJECT_WORDS.some((word) => phrase.includes(word))) return false;
  if (PUBLIC_FIGURE_BLACKLIST.some((name) => phrase.includes(name))) return false;
  const words = phrase.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  if (words.every((word) => STOP_WORDS.has(word))) return false;
  return hasProductSignal(phrase);
}

function hasNonProductNoise(title) {
  const value = cleanKeywordText(title);
  return PUBLIC_FIGURE_BLACKLIST.some((name) => value.includes(name))
    || REJECT_WORDS.some((word) => value.includes(word))
    || /\b\d{2,}\b/.test(value);
}

function hasProductSignal(phrase) {
  return PRODUCT_KEYWORD_WHITELIST.some((word) => phrase.includes(word))
    || PRODUCT_INTENT_WORDS.some((word) => phrase.includes(word));
}

function scoreKeywordPhrase(phrase, base = "") {
  const value = cleanKeywordText(phrase);
  let score = 0;
  if (base && value.includes(base)) score += 30;
  PRODUCT_KEYWORD_WHITELIST.forEach((word) => {
    if (value.includes(word)) score += 8;
  });
  PRODUCT_INTENT_WORDS.forEach((word) => {
    if (value.includes(word)) score += 5;
  });
  if (value.split(/\s+/).length === 2) score += 8;
  if (value.split(/\s+/).length === 3) score += 5;
  if (/\d/.test(value)) score -= 20;
  return score;
}

function buildShortsStats(items, recommendations) {
  const totalViews = items.reduce((sum, item) => sum + Number(item.views || 0), 0);
  const totalEngagement = items.reduce((sum, item) => sum + Number(item.engagementRate || 0), 0);
  return {
    averageViews: items.length ? Math.round(totalViews / items.length) : 0,
    averageEngagement: items.length ? totalEngagement / items.length : 0,
    topKeyword: recommendations[0] || ""
  };
}

function titleSignature(title) {
  return tokenize(title)
    .filter((word) => !STOP_WORDS.has(word))
    .filter((word) => !PRODUCT_INTENT_WORDS.includes(word))
    .sort()
    .join(" ");
}

function similarity(a, b) {
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  const overlap = Array.from(left).filter((item) => right.has(item)).length;
  return overlap / Math.max(left.size, right.size);
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function matchProductsToShorts(shorts, products) {
  return products.map((product, index) => {
    const bestShort = shorts
      .map((short) => ({
        short,
        relevance: Math.max(
          keywordRelevance(product.name || "", short.title || ""),
          ...(short.extractedKeywords || []).map((keyword) => keywordRelevance(product.name || "", keyword))
        )
      }))
      .sort((a, b) => b.relevance - a.relevance)[0];
    const opportunity = scoreOpportunity({
      short: bestShort?.short,
      product,
      relevance: bestShort?.relevance || 0,
      rank: index
    });

    return {
      ...product,
      matchedShort: bestShort?.short || null,
      matchedShortTitle: bestShort?.short?.title || "",
      matchedKeyword: pickMatchedKeyword(product, bestShort?.short),
      relevance: bestShort?.relevance || 0,
      opportunity
    };
  }).sort((a, b) => b.opportunity.chance - a.opportunity.chance);
}

function buildOpportunities(shorts, products) {
  return shorts.map((short, index) => {
    const keywords = short.extractedKeywords || extractProductKeywords(short.title);
    const bestProduct = findBestProductForShort(short, products, keywords);
    const opportunity = scoreOpportunity({
      short,
      product: bestProduct?.product || null,
      relevance: bestProduct?.relevance || (keywords.length ? 0.25 : 0.1),
      rank: index
    });
    return {
      type: bestProduct?.product ? "cross-platform-validation" : "marketplace-pending",
      product: bestProduct?.product || null,
      topProduct: bestProduct?.product || null,
      short,
      title: short.title,
      price: bestProduct?.product?.price || "",
      image: short.thumbnail || bestProduct?.product?.image || "",
      url: bestProduct?.product?.url || short.url,
      matchedShortTitle: short.title,
      keyword: bestProduct?.keyword || keywords[0] || "",
      matchedKeyword: bestProduct?.keyword || keywords[0] || "",
      chance: opportunity.chance,
      score: opportunity.score,
      label: opportunity.label,
      validationStatus: bestProduct?.product ? "validated" : "pending-marketplace",
      reason: bestProduct?.product ? opportunity.reason : "Menunggu validasi marketplace"
    };
  }).sort((a, b) => b.chance - a.chance).slice(0, 20);
}

function scoreOpportunity({ short, product, relevance, rank }) {
  const views = Number(short?.views || 0);
  const publishedAt = short?.publishedAt ? new Date(short.publishedAt).getTime() : Date.now();
  const ageHours = Math.max(1, (Date.now() - publishedAt) / 36e5);
  const recency = Math.max(0, 1 - Math.log2(ageHours + 1) / 12);
  const viewTrendScore = Math.min(100, Math.log10(Math.max(views, 1)) / 7 * 78 + recency * 22);
  const affiliateScore = Number(product?.chance ?? product?.score);
  const soldScore = normalizeSold(product?.soldCount || product?.items_sold || 0) * 100;
  const ratingScore = normalizeRating(product?.rating || 0) * 100;
  const reviewScore = normalizeReview(product?.reviewCount || product?.total_buyers || 0) * 100;
  const marketplaceScore = product
    ? (Number.isFinite(affiliateScore) ? affiliateScore : (soldScore * 0.35 + ratingScore * 0.15 + reviewScore * 0.1) / 0.6)
    : 0;
  const relevanceBoost = product ? Math.min(8, relevance * 8) : 0;
  const rankPenalty = Math.min(5, rank * 0.25);
  const score = Math.round(viewTrendScore * 0.4 + marketplaceScore * 0.6 + relevanceBoost - rankPenalty);
  const chance = Math.max(0, Math.min(100, score));

  return {
    score,
    chance,
    label: opportunityLabel(chance),
    reason: buildReason({
      views,
      ageHours,
      relevance,
      sold: product?.soldCount || 0,
      itemsSold: product?.items_sold || 0,
      orders: product?.orders || 0,
      clicks: product?.clicks || 0,
      roi: product?.roi || 0,
      newBuyers: product?.new_buyers || 0,
      rating: product?.rating || 0,
      reviewCount: product?.reviewCount || 0
    })
  };
}

function findBestProductForShort(short, products, keywords) {
  return (products || [])
    .map((product) => {
      const keywordMatches = (keywords || []).map((keyword) => ({
        keyword,
        relevance: keywordRelevance(product.name || "", keyword)
      }));
      const bestKeyword = keywordMatches.sort((a, b) => b.relevance - a.relevance)[0];
      const relevance = Math.max(
        keywordRelevance(product.name || "", short.title || ""),
        bestKeyword?.relevance || 0
      );
      const marketplaceRank = normalizeSold(product.soldCount || 0) * 0.55
        + normalizeRating(product.rating || 0) * 0.25
        + normalizeReview(product.reviewCount || 0) * 0.2;
      return { product, keyword: bestKeyword?.keyword || "", relevance, marketplaceRank };
    })
    .filter((item) => item.relevance >= 0.12)
    .sort((a, b) => (b.relevance + b.marketplaceRank) - (a.relevance + a.marketplaceRank))[0] || null;
}

function buildReason({ views, ageHours, relevance, sold, itemsSold, orders, clicks, roi, newBuyers, rating, reviewCount }) {
  const parts = [];
  if (views) parts.push(`${formatCompact(views)} views Shorts`);
  if (ageHours < 72) parts.push("upload masih baru");
  if (relevance >= 0.3) parts.push("keyword relevan");
  if (Number(itemsSold || sold || 0) > 0) parts.push(`${formatCompact(itemsSold || sold)} terjual`);
  if (Number(orders || 0) > 0) parts.push(`${formatCompact(orders)} order`);
  if (Number(clicks || 0) > 0) parts.push(`${formatCompact(clicks)} klik`);
  if (Number(roi || 0) > 0) parts.push(`${Number(roi).toFixed(1)} ROI`);
  if (Number(newBuyers || 0) > 0) parts.push(`${formatCompact(newBuyers)} buyer baru`);
  if (Number(rating || 0) > 0) parts.push(`${Number(rating).toFixed(1)} rating`);
  if (Number(reviewCount || 0) > 0) parts.push(`${formatCompact(reviewCount)} review`);
  return parts.length ? parts.join(" | ") : "Sinyal awal dari Shorts Indonesia.";
}

function pickMatchedKeyword(product, short) {
  const keywords = short?.extractedKeywords || [];
  return keywords
    .map((keyword) => ({ keyword, relevance: keywordRelevance(product.name || "", keyword) }))
    .sort((a, b) => b.relevance - a.relevance)[0]?.keyword || "";
}

function formatCompact(value) {
  return new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

module.exports = {
  buildOpportunities,
  fetchYouTubeShortsIndonesia,
  matchProductsToShorts,
  opportunityLabel,
  scoreOpportunity
};
