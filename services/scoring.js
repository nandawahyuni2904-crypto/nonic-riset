function scoreTikTokVideos(items, keyword) {
  return items
    .map((item) => {
      const views = Number(item.views || 0);
      const likes = Number(item.likes || 0);
      const comments = Number(item.comments || 0);
      const engagementRatio = views > 0 ? (likes + comments * 2) / views : 0;
      const relevance = keywordRelevance(`${item.title || ""} ${item.username || ""}`, keyword);
      const viewScore = Math.min(42, Math.log10(Math.max(views, 1)) * 7.5);
      const engagementScore = Math.min(34, engagementRatio * 1350);
      const commentScore = Math.min(10, Math.log10(Math.max(comments, 1)) * 3);
      const relevanceScore = relevance * 24;
      const score = Math.round(viewScore + engagementScore + commentScore + relevanceScore);

      return {
        ...item,
        engagementRatio,
        relevance,
        score,
        label: labelScore(score)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function scoreShopeeProducts(items, keyword, tiktokSignal = 0) {
  return items
    .map((item, index) => {
      const sold = Number(item.soldCount || 0);
      const rating = Number(item.rating || 0);
      const reviewCount = Number(item.reviewCount || 0);
      const relevance = keywordRelevance(item.name || "", keyword);
      const soldScore = normalizeSold(sold) * 35;
      const ratingScore = normalizeRating(rating) * 15;
      const reviewScore = normalizeReview(reviewCount) * 10;
      const relevanceScore = relevance * 25;
      const rankScore = Math.max(0, 10 - index);
      const signalScore = Math.min(20, tiktokSignal / 5);
      const score = Math.round(soldScore + ratingScore + reviewScore + relevanceScore + rankScore + signalScore);

      return {
        ...item,
        relevance,
        score,
        label: opportunityLabel(score)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function scoreTikTokShopProducts(items, keyword) {
  return items
    .map((item, index) => {
      const sold = Number(item.soldCount || 0);
      const rating = Number(item.rating || 0);
      const relevance = keywordRelevance(`${item.name || ""} ${item.shopName || ""}`, keyword);
      const soldScore = Math.min(36, Math.log10(Math.max(sold, 1)) * 10);
      const ratingScore = rating ? Math.min(18, rating * 3.6) : 0;
      const relevanceScore = relevance * 28;
      const priceScore = item.price ? 8 : 0;
      const commissionScore = item.commission ? 8 : 0;
      const rankScore = Math.max(0, 12 - index);
      const score = Math.round(soldScore + ratingScore + relevanceScore + priceScore + commissionScore + rankScore);

      return {
        ...item,
        relevance,
        score,
        chance: Math.max(5, Math.min(99, Math.round(score))),
        label: labelScore(score)
      };
    })
    .sort((a, b) => b.score - a.score);
}

function labelScore(score) {
  if (score >= 82) return "HOT";
  if (score >= 64) return "NAIK";
  if (score >= 38) return "POTENSIAL";
  return "LOW";
}

function opportunityLabel(score) {
  if (score >= 85) return "HOT";
  if (score >= 70) return "POTENSIAL";
  if (score >= 50) return "MENARIK";
  return "LOW";
}

function normalizeSold(value) {
  return Math.min(1, Math.log10(Math.max(Number(value || 0), 1)) / 5);
}

function normalizeRating(value) {
  const rating = Number(value || 0);
  return rating > 0 ? Math.min(1, rating / 5) : 0;
}

function normalizeReview(value) {
  return Math.min(1, Math.log10(Math.max(Number(value || 0), 1)) / 4);
}

function parseCount(value) {
  if (typeof value === "number") return value;
  const raw = String(value || "").toLowerCase().replace(/\s+/g, "");
  if (!raw) return 0;

  const match = raw.match(/([\d.,]+)(rb|ribu|jt|juta|m|k|b|bn|miliar)?/i);
  if (!match) return 0;

  const number = Number(match[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(number)) return 0;

  const suffix = match[2] || "";
  if (suffix === "rb" || suffix === "ribu" || suffix === "k") return Math.round(number * 1000);
  if (suffix === "jt" || suffix === "juta" || suffix === "m") return Math.round(number * 1000000);
  if (suffix === "b" || suffix === "bn" || suffix === "miliar") return Math.round(number * 1000000000);
  return Math.round(number);
}

function keywordRelevance(text, keyword) {
  const words = tokenize(keyword);
  if (words.length === 0) return 0;

  const haystack = ` ${tokenize(text).join(" ")} `;
  const matched = words.filter((word) => haystack.includes(` ${word} `)).length;
  return matched / words.length;
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u1e00-\u1eff]+/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

module.exports = {
  keywordRelevance,
  labelScore,
  normalizeRating,
  normalizeReview,
  normalizeSold,
  opportunityLabel,
  parseCount,
  scoreShopeeProducts,
  scoreTikTokShopProducts,
  scoreTikTokVideos
};
