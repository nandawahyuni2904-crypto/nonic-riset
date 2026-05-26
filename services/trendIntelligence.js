const { extractProductKeywords, tokenize } = require("./keywordExtraction");

const VIRAL_HOOKS = [
  "akhirnya",
  "ternyata",
  "viral",
  "murah",
  "murah banget",
  "shopee",
  "racun shopee",
  "tiktok",
  "unboxing",
  "review",
  "wajib punya",
  "bikin nagih",
  "before after",
  "auto rapi",
  "auto bersih"
];

const AFFILIATE_TERMS = [
  "shopee", "tiktok shop", "affiliate", "checkout", "keranjang", "racun",
  "review", "unboxing", "rekomendasi", "murah", "diskon", "promo", "aesthetic",
  "portable", "multifungsi", "unik", "viral", "haul", "beli", "wajib punya"
];

const NOISE_TERMS = [
  "prank", "meme", "ngakak", "lucu", "challenge", "reaction", "anime", "gameplay",
  "story", "siram", "kucing", "drama", "gosip", "klarifikasi", "part", "episode"
];

const FILLER_TERMS = new Set([
  "full", "video", "shorts", "short", "fyp", "foryou", "subtitle", "subtitles",
  "caption", "viral", "banget", "nih", "dong", "guys", "bestie", "auto", "langsung"
  , "akhirnya", "ternyata"
]);

const PERSON_NAMES = new Set([
  "amanda", "manopo", "soimah", "raffi", "ahmad", "nagita", "slavina", "ayu",
  "ting", "tingting", "fuji", "atta", "aurel", "ruben", "onsu", "sarwendah",
  "lesti", "billar", "syahrini", "rizky", "billy", "ivan", "gunawan", "nikita",
  "mirzani", "baim", "paula", "denny", "cagur", "andre", "taulany", "wendi"
]);

const PRODUCT_ANGLE_TERMS = [
  "aesthetic", "portable", "multifungsi", "murah", "unik", "mini", "lipat",
  "hemat", "praktis", "viral", "kekinian", "premium", "travel", "minimalis"
];

const TREND_CATEGORIES = {
  home: ["rumah", "rak", "lemari", "sprei", "karpet", "lampu", "organizer", "pembersih", "dekorasi"],
  beauty: ["skincare", "serum", "masker", "makeup", "parfum", "lip", "beauty"],
  gadget: ["gadget", "hp", "charger", "case", "casing", "kabel", "laptop", "keyboard", "speaker"],
  fashion: ["fashion", "baju", "kaos", "celana", "jaket", "hoodie", "sepatu", "tas", "dompet"],
  otomotif: ["motor", "mobil", "helm", "spion", "ban", "otomotif"],
  dapur: ["dapur", "panci", "wajan", "pisau", "sendok", "gelas", "botol", "blender"],
  bayi: ["bayi", "baby", "anak", "kids", "mainan", "stroller"],
  kesehatan: ["kesehatan", "sehat", "vitamin", "alat terapi", "humidifier", "masker"]
};

function enrichTrendIntelligence(items = [], contextKeywords = []) {
  const cleanedContext = contextKeywords.map(cleanKeywordPhrase).filter(Boolean);
  const channelCounts = frequency(items.map((item) => item.channel || item.channelTitle || "").filter(Boolean));
  const enriched = items.map((item) => enrichItem(item, cleanedContext, channelCounts));
  const allKeywords = enriched.flatMap((item) => item.important_keywords || []);
  const clusters = clusterKeywords(allKeywords.concat(cleanedContext));
  const summary = buildAnalyticsSummary(enriched, clusters);
  return {
    items: enriched,
    trendClusters: clusters,
    analyticsSummary: summary,
    keywordRecommendations: clusters.map((cluster) => cluster.parentKeyword).slice(0, 10),
    topProductAngles: summary.topProductAngles
  };
}

function enrichItem(item, contextKeywords = [], channelCounts = []) {
  const rawTitle = item.title || item.item_name || item.name || "";
  const title = cleanTitle(rawTitle);
  const hooks = detectViralHooks(rawTitle);
  const importantKeywords = extractProductKeywords(title, contextKeywords.join(", "))
    .map(cleanKeywordPhrase)
    .filter(Boolean);
  const clusters = clusterKeywords(importantKeywords);
  const commercialIntent = scoreProductIntent(title, importantKeywords.concat(contextKeywords));
  const breakdown = buildConfidenceBreakdown(item, title, commercialIntent);
  const opportunityScore = Math.round((breakdown.keywordScore * 0.25) + (breakdown.engagementScore * 0.25) + (breakdown.recencyScore * 0.2) + (breakdown.affiliateIntentScore * 0.3));
  const parentKeyword = clusters[0]?.parentKeyword || importantKeywords[0] || "";
  const category = detectTrendCategory(`${title} ${importantKeywords.join(" ")}`);
  const competitor = detectCompetitorChannel(item.channel || item.channelTitle || "", channelCounts);
  return {
    ...item,
    title: item.title || title,
    cleaned_title: title,
    viral_hooks: hooks,
    commercial_intent: commercialIntent,
    product_intent_score: commercialIntent,
    opportunity_score: opportunityScore,
    opportunity_score_label: opportunityLabel(opportunityScore),
    visual_indicators: buildVisualIndicators(item, commercialIntent, competitor),
    why_this_is_viral: buildWhyViral(item, hooks, title, commercialIntent),
    confidence_breakdown: breakdown,
    important_keywords: importantKeywords,
    extractedKeywords: item.extractedKeywords || importantKeywords,
    parent_keyword: parentKeyword,
    trend_category: category,
    competitor_channel: competitor,
    estimated_product_type: item.estimated_product_type || parentKeyword || item.estimatedProductType || "",
    product_confidence: Math.max(Number(item.product_confidence || 0), commercialIntent, opportunityScore),
    confidence_label: item.confidence_label || labelConfidence(Math.max(Number(item.product_confidence || 0), commercialIntent, opportunityScore))
  };
}

function detectViralHooks(value) {
  const clean = normalize(value);
  return VIRAL_HOOKS.filter((hook) => clean.includes(hook));
}

function scoreProductIntent(value, keywords = []) {
  const clean = normalize(value);
  let score = 0;
  AFFILIATE_TERMS.forEach((term) => {
    if (clean.includes(term)) score += term.length > 8 ? 12 : 8;
  });
  keywords.forEach((keyword) => {
    const phrase = cleanKeywordPhrase(keyword);
    if (phrase && clean.includes(phrase)) score += 10;
  });
  if (extractProductKeywords(clean).length) score += 20;
  NOISE_TERMS.forEach((term) => {
    if (clean.includes(term)) score -= 18;
  });
  return clamp(Math.round(score), 0, 100);
}

function clusterKeywords(keywords = []) {
  const groups = [];
  for (const keyword of keywords.map(cleanKeywordPhrase).filter(Boolean)) {
    const existing = groups.find((group) => areSimilar(group.parentKeyword, keyword) || group.items.some((item) => areSimilar(item, keyword)));
    if (existing) {
      existing.items.push(keyword);
      existing.count += 1;
      existing.parentKeyword = pickParentKeyword(existing.items);
    } else {
      groups.push({ parentKeyword: keyword, count: 1, items: [keyword] });
    }
  }
  return groups
    .map((group) => ({
      ...group,
      items: dedupe(group.items),
      parentKeyword: pickParentKeyword(group.items)
    }))
    .sort((a, b) => b.count - a.count || b.parentKeyword.length - a.parentKeyword.length);
}

function buildAnalyticsSummary(items = [], clusters = []) {
  const avgViews = average(items.map((item) => Number(item.views || 0)));
  const avgEngagement = average(items.map((item) => Number(item.engagementRate || 0)));
  const uploadHours = frequency(items.map((item) => {
    const date = item.publishedAt ? new Date(item.publishedAt) : null;
    return date && !Number.isNaN(date.getTime()) ? `${String(date.getHours()).padStart(2, "0")}:00` : "";
  }).filter(Boolean));
  const channelFrequency = frequency(items.map((item) => item.channel || item.channelTitle || "").filter(Boolean));
  const angles = frequency(items.flatMap((item) => detectProductAngles(`${item.title || ""} ${(item.important_keywords || []).join(" ")}`)));
  const uploadDays = frequency(items.map((item) => {
    const date = item.publishedAt ? new Date(item.publishedAt) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "";
  }).filter(Boolean));
  const categoryHeatmap = buildCategoryHeatmap(items);
  return {
    averageViews: Math.round(avgViews),
    averageEngagement: avgEngagement,
    avgViews: Math.round(avgViews),
    avgEngagement,
    topUploadHour: uploadHours[0]?.value || "",
    uploadDistributionByHour: uploadHours,
    uploadDistributionByDay: uploadDays,
    topChannelFrequency: channelFrequency.slice(0, 8),
    trendFarmingChannels: channelFrequency.filter((item) => item.count >= 2).slice(0, 8),
    topProductAngle: angles[0]?.value || "",
    topProductAngles: angles.map((item) => item.value).slice(0, 8),
    trendCategoryHeatmap: categoryHeatmap,
    topKeyword: clusters[0]?.parentKeyword || ""
  };
}

function buildConfidenceBreakdown(item, title, commercialIntent) {
  const views = Number(item.views || 0);
  const engagement = Number(item.engagementRate || 0);
  const publishedAt = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  const ageDays = publishedAt ? Math.max(0, (Date.now() - publishedAt) / 864e5) : 999;
  const keywordScore = clamp((extractProductKeywords(title).length * 20) + (detectProductAngles(title).length * 10), 0, 100);
  const engagementScore = clamp(Math.round(engagement * 1600) + (views > 100000 ? 20 : views > 25000 ? 10 : 0), 0, 100);
  const recencyScore = clamp(Math.round(100 - ageDays * 3.2), 0, 100);
  return {
    keywordScore,
    engagementScore,
    recencyScore,
    affiliateIntentScore: commercialIntent
  };
}

function buildVisualIndicators(item, commercialIntent, competitor) {
  const engagement = Number(item.engagementRate || 0);
  const publishedAt = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  const ageDays = publishedAt ? Math.max(0, (Date.now() - publishedAt) / 864e5) : 999;
  return [
    engagement >= 0.035 ? "high engagement" : "",
    ageDays <= 30 ? "recent upload" : "",
    competitor?.isTrendFarming ? "trend farming channel" : "low competition",
    commercialIntent >= 60 ? "affiliate intent" : ""
  ].filter(Boolean);
}

function buildWhyViral(item, hooks, title, commercialIntent) {
  const reasons = [];
  if (hooks.length) reasons.push(`strong emotional hook: ${hooks.slice(0, 2).join(", ")}`);
  if (/before after|auto rapi|auto bersih|review|unboxing/.test(normalize(title))) reasons.push("visual demonstration");
  if (Number(item.engagementRate || 0) >= 0.035) reasons.push("high replay potential");
  if (/murah|promo|diskon|shopee|racun/.test(normalize(title)) || commercialIntent >= 70) reasons.push("cheap impulse-buy product");
  if (/tiktok|racun|viral|fyp/.test(normalize(item.title || title))) reasons.push("TikTok style format");
  return reasons.length ? reasons : ["product angle is clear enough to test with short-form content"];
}

function opportunityLabel(score) {
  if (score >= 80) return "HOT";
  if (score >= 60) return "WARM";
  if (score >= 40) return "TEST";
  return "AVOID";
}

function detectCompetitorChannel(channel, channelCounts) {
  const found = channelCounts.find((item) => item.value === channel);
  const count = found?.count || 0;
  return {
    channel,
    count,
    isTrendFarming: count >= 3
  };
}

function detectTrendCategory(value) {
  const clean = normalize(value);
  let best = { category: "home", score: 0 };
  Object.entries(TREND_CATEGORIES).forEach(([category, terms]) => {
    const score = terms.reduce((sum, term) => sum + (clean.includes(term) ? 1 : 0), 0);
    if (score > best.score) best = { category, score };
  });
  return best.category;
}

function buildCategoryHeatmap(items) {
  const base = Object.keys(TREND_CATEGORIES).map((category) => ({ category, count: 0 }));
  items.forEach((item) => {
    const category = item.trend_category || detectTrendCategory(`${item.title || ""} ${(item.important_keywords || []).join(" ")}`);
    const target = base.find((entry) => entry.category === category);
    if (target) target.count += 1;
  });
  const max = Math.max(...base.map((item) => item.count), 1);
  return base.map((item) => ({
    ...item,
    intensity: Math.round((item.count / max) * 100)
  }));
}

function toCsv(items = []) {
  const rows = [["title", "views", "likes", "confidence", "keyword", "niche", "url"]];
  items.forEach((item) => {
    rows.push([
      item.title || item.item_name || item.name || "",
      item.views || 0,
      item.likes || 0,
      item.product_confidence || item.commercial_intent || item.score || 0,
      item.parent_keyword || item.keyword || (item.important_keywords || [])[0] || "",
      item.auto_niche || item.niche || "",
      item.url || ""
    ]);
  });
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function cleanTitle(value) {
  return normalize(value)
    .split(" ")
    .filter((word) => !PERSON_NAMES.has(word))
    .filter((word) => !FILLER_TERMS.has(word))
    .filter((word) => !/^\d+$/.test(word))
    .join(" ")
    .trim();
}

function cleanKeywordPhrase(value) {
  const words = normalize(value)
    .split(" ")
    .filter((word) => word.length > 2)
    .filter((word) => !PERSON_NAMES.has(word))
    .filter((word) => !FILLER_TERMS.has(word))
    .filter((word) => !/^\d+$/.test(word));
  const phrase = words.join(" ").trim();
  if (phrase.length < 4) return "";
  return phrase;
}

function pickParentKeyword(items) {
  const clean = dedupe(items.map(cleanKeywordPhrase).filter(Boolean));
  const productHint = clean.find((item) => tokenize(item).length <= 3 && extractProductKeywords(item).length);
  return productHint || clean.sort((a, b) => a.length - b.length)[0] || "";
}

function areSimilar(a, b) {
  const left = cleanKeywordPhrase(a);
  const right = cleanKeywordPhrase(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const leftWords = new Set(left.split(" "));
  const rightWords = new Set(right.split(" "));
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  if (overlap >= Math.min(leftWords.size, rightWords.size)) return true;
  return levenshtein(left, right) <= Math.max(1, Math.floor(Math.min(left.length, right.length) * 0.18));
}

function detectProductAngles(value) {
  const clean = normalize(value);
  return PRODUCT_ANGLE_TERMS.filter((term) => clean.includes(term));
}

function frequency(values) {
  const counts = new Map();
  values.forEach((value) => {
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/#[\w-]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return matrix[a.length][b.length];
}

function labelConfidence(value) {
  if (value >= 80) return "HOT";
  if (value >= 60) return "GOOD";
  return "LOW";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dedupe(items) {
  return [...new Set(items)];
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

module.exports = {
  AFFILIATE_TERMS,
  NOISE_TERMS,
  VIRAL_HOOKS,
  buildAnalyticsSummary,
  cleanKeywordPhrase,
  clusterKeywords,
  detectViralHooks,
  enrichTrendIntelligence,
  scoreProductIntent,
  toCsv
};
