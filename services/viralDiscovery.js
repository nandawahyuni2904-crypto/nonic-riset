const fs = require("node:fs/promises");
const path = require("node:path");
const { expandKeyword } = require("./keywordExpansion");
const { extractProductKeywords } = require("./keywordExtraction");
const { enrichTrendIntelligence, clusterKeywords } = require("./trendIntelligence");
const { filterQualityShorts } = require("./qualityFilter");

const DATA_DIR = path.join(__dirname, "..", "data");
const DISCOVERY_CACHE_FILE = path.join(DATA_DIR, "discovery-cache.json");
const DAILY_TTL_MS = 24 * 60 * 60 * 1000;
const SEEDS = ["gadget", "dapur", "rumah", "kecantikan", "fashion", "bayi", "kesehatan", "otomotif"];
const SEED_SUBKEYWORDS = {
  gadget: ["gadget viral", "lampu sensor", "charger portable", "case hp unik"],
  dapur: ["organizer dapur", "gelas portable", "alat dapur viral", "rak dapur"],
  rumah: ["rak sepatu", "lampu sensor", "alat pembersih", "organizer rumah"],
  kecantikan: ["skincare viral", "parfum viral", "alat makeup", "beauty gadget"],
  fashion: ["tas viral", "sepatu viral", "outfit wanita", "dompet minimalis"],
  bayi: ["perlengkapan bayi", "mainan bayi", "alat makan bayi", "baby gear"],
  kesehatan: ["alat kesehatan", "alat pijat", "humidifier", "produk wellness"],
  otomotif: ["aksesoris mobil", "aksesoris motor", "helm viral", "alat cuci mobil"]
};

async function discoverViralProducts({ fetchYouTubeTrends, force = false } = {}) {
  if (!force) {
    const cached = await readDiscoveryCache();
    if (cached && Date.now() - Number(cached.timestamp || 0) < DAILY_TTL_MS) {
      return { ...cached.result, fromCache: true };
    }
  }

  const keywords = buildDiscoveryKeywords();
  const runs = await Promise.allSettled(keywords.map((keyword) => (
    fetchYouTubeShortsSafe({ keyword, fetchYouTubeTrends })
  )));
  const videos = filterQualityShorts(runs.flatMap((run) => run.status === "fulfilled" ? run.value : []));
  const intelligence = enrichTrendIntelligence(videos, keywords);
  const enrichedVideos = intelligence.items;
  const opportunities = buildEmergingProducts(enrichedVideos, keywords);
  const result = {
    mode: "auto-discovery",
    seeds: SEEDS,
    keywords,
    emergingProducts: opportunities,
    trendClusters: intelligence.trendClusters,
    analyticsSummary: intelligence.analyticsSummary,
    debug: {
      keywordCount: keywords.length,
      rawVideoCount: videos.length,
      enrichedVideoCount: enrichedVideos.length,
      errors: runs.map((run, index) => run.status === "rejected" ? `${keywords[index]}: ${run.reason.message}` : "").filter(Boolean)
    },
    refreshedAt: new Date().toISOString(),
    fromCache: false
  };
  await writeDiscoveryCache(result);
  return result;
}

function buildDiscoveryKeywords() {
  const maxPerSeed = Number(process.env.DISCOVERY_KEYWORDS_PER_SEED || 1);
  return SEEDS.flatMap((seed) => {
    const expanded = [
      ...(SEED_SUBKEYWORDS[seed] || []),
      ...expandKeyword(seed, 3)
    ];
    return dedupe(expanded).slice(0, Math.max(1, maxPerSeed));
  });
}

async function fetchYouTubeShortsSafe({ keyword, fetchYouTubeTrends }) {
  const { fetchYouTubeShortsIndonesia } = require("./shortsResearch");
  const data = await fetchYouTubeShortsIndonesia({
    keyword,
    limit: Number(process.env.DISCOVERY_LIMIT_PER_KEYWORD || 8),
    days: 30,
    fetchYouTubeTrends,
    maxKeywords: 1
  });
  return (data.items || []).map((item) => ({ ...item, discoverySeed: keyword }));
}

function buildEmergingProducts(videos = [], contextKeywords = []) {
  const avgEngagement = average(videos.map((item) => Number(item.engagementRate || 0)));
  const keywordCounts = countKeywords(videos, contextKeywords);
  const candidates = videos
    .map((item) => buildCandidate(item, avgEngagement, keywordCounts))
    .filter((item) => item.isBreakoutCandidate || item.momentum_score >= 35);
  return suppressDuplicateTrends(candidates)
    .sort((a, b) => b.momentum_score - a.momentum_score || b.avg_views - a.avg_views)
    .slice(0, 16);
}

function buildCandidate(item, avgEngagement, keywordCounts) {
  const publishedAt = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
  const ageDays = publishedAt ? Math.max(0.1, (Date.now() - publishedAt) / 864e5) : 999;
  const recency = Math.max(0, 1 - ageDays / 30);
  const engagement = Number(item.engagementRate || 0);
  const velocity = Number(item.velocity || 0) || Number(item.views || 0) / Math.max(1, ageDays * 24);
  const productKeywords = item.important_keywords || item.extractedKeywords || extractProductKeywords(item.title || "");
  const keyword = item.parent_keyword || productKeywords[0] || item.discoverySeed || "";
  const repeatCount = Math.max(...productKeywords.map((key) => keywordCounts.get(normalizeKey(key)) || 0), keywordCounts.get(normalizeKey(keyword)) || 0, 1);
  const rawMomentum = velocity * Math.max(0.001, engagement) * Math.max(0.15, recency) * Math.log2(repeatCount + 1);
  const momentumScore = normalizeMomentum(rawMomentum);
  const isBreakoutCandidate = ageDays <= 14 && engagement >= avgEngagement && repeatCount >= 1;
  return {
    keyword,
    parentKeyword: keyword,
    title: item.title,
    url: item.url,
    thumbnail: item.thumbnail,
    channel: item.channel,
    avg_views: Number(item.views || 0),
    views: Number(item.views || 0),
    engagement,
    confidence: Number(item.product_confidence || item.commercial_intent || 0),
    product_confidence: Number(item.product_confidence || item.commercial_intent || 0),
    top_hook: (item.viral_hooks || [])[0] || "",
    viral_hooks: item.viral_hooks || [],
    momentum_score: momentumScore,
    momentum_raw: Math.round(rawMomentum),
    lifecycle: lifecycleLabel({ ageDays, momentumScore, repeatCount }),
    age_days: Math.round(ageDays * 10) / 10,
    repeat_count: repeatCount,
    isBreakoutCandidate,
    discoverySeed: item.discoverySeed
  };
}

function suppressDuplicateTrends(items = []) {
  const groups = new Map();
  items.forEach((item) => {
    const key = normalizeKey(item.keyword);
    const existingKey = [...groups.keys()].find((candidate) => areSimilarKey(candidate, key));
    const targetKey = existingKey || key;
    const current = groups.get(targetKey);
    if (!current || item.momentum_score > current.momentum_score) {
      groups.set(targetKey, {
        ...item,
        keyword: current?.keyword || item.keyword,
        merged_count: (current?.merged_count || 0) + 1
      });
    } else {
      current.merged_count = (current.merged_count || 1) + 1;
    }
  });
  return Array.from(groups.values());
}

function countKeywords(videos, contextKeywords) {
  const counts = new Map();
  videos.forEach((item) => {
    const keys = item.important_keywords || item.extractedKeywords || extractProductKeywords(item.title || "");
    keys.concat(contextKeywords).forEach((key) => {
      const clean = normalizeKey(key);
      if (!clean) return;
      counts.set(clean, (counts.get(clean) || 0) + 1);
    });
  });
  return counts;
}

function lifecycleLabel({ ageDays, momentumScore, repeatCount }) {
  if (momentumScore >= 82 && repeatCount >= 3) return "SATURATED";
  if (momentumScore >= 75) return "HOT";
  if (momentumScore >= 45) return "RISING";
  if (ageDays <= 14) return "EARLY";
  return "RISING";
}

function normalizeMomentum(value) {
  return Math.max(0, Math.min(100, Math.round(Math.log10(Math.max(1, value)) * 22)));
}

function areSimilarKey(a, b) {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  const overlap = [...left].filter((word) => right.has(word)).length;
  return overlap >= Math.min(left.size, right.size);
}

async function readDiscoveryCache() {
  try {
    return JSON.parse(await fs.readFile(DISCOVERY_CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function writeDiscoveryCache(result) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DISCOVERY_CACHE_FILE, `${JSON.stringify({ timestamp: Date.now(), result }, null, 2)}\n`, "utf8");
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^\w\s\u00c0-\u024f\u1e00-\u1eff]/g, " ").replace(/\s+/g, " ").trim();
}

function dedupe(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

module.exports = {
  SEEDS,
  buildDiscoveryKeywords,
  discoverViralProducts,
  suppressDuplicateTrends
};
