const { JsonStore } = require("./jsonStore");

const store = new JsonStore("analytics.json", {
  searches: {},
  momentum: {},
  niches: {},
  events: []
});

function recordSearchAnalytics({ keyword = "", category = "", mode = "manual", result = {} }) {
  const searchKey = (category || keyword || mode || "auto").toLowerCase();
  const highest = highestMomentum(result);
  const niche = bestNiche(result);
  store.update((data) => {
    increment(data.searches, searchKey);
    if (highest.keyword) data.momentum[highest.keyword] = Math.max(Number(data.momentum[highest.keyword] || 0), highest.score);
    if (niche) increment(data.niches, niche);
    data.events = (data.events || []).slice(-199);
    data.events.push({
      at: new Date().toISOString(),
      mode,
      keyword,
      category,
      count: (result.shorts || []).length,
      topMomentumKeyword: highest.keyword,
      topMomentumScore: highest.score,
      niche
    });
    return data;
  });
}

function getSearchAnalytics() {
  const data = store.read();
  return {
    mostSearchedKeyword: topEntry(data.searches),
    highestMomentumKeyword: topEntry(data.momentum),
    bestPerformingNiche: topEntry(data.niches),
    totals: {
      searchTerms: Object.keys(data.searches || {}).length,
      events: (data.events || []).length
    },
    recent: (data.events || []).slice(-20).reverse()
  };
}

function highestMomentum(result) {
  const candidates = [
    ...(result.emergingProducts || []),
    ...(result.shorts || []),
    ...(result.opportunities || [])
  ];
  const best = candidates
    .map((item) => ({
      keyword: item.keyword || item.parent_keyword || item.parentKeyword || item.estimated_product_type || "",
      score: Number(item.momentum_score || item.trend_score_final || item.product_confidence || item.score || 0)
    }))
    .filter((item) => item.keyword)
    .sort((a, b) => b.score - a.score)[0];
  return best || { keyword: "", score: 0 };
}

function bestNiche(result) {
  const shorts = result.shorts || [];
  const counts = {};
  shorts.forEach((item) => {
    const niche = item.trend_category || item.auto_niche || "";
    if (niche) increment(counts, niche);
  });
  return topEntry(counts)?.key || "";
}

function increment(object, key) {
  if (!key) return;
  object[key] = Number(object[key] || 0) + 1;
}

function topEntry(object = {}) {
  const entry = Object.entries(object).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return entry ? { key: entry[0], value: entry[1] } : null;
}

module.exports = {
  getSearchAnalytics,
  recordSearchAnalytics
};
