const SPAM_CHANNEL_PATTERNS = [/reupload/i, /kompilasi/i, /viral shorts/i, /random/i, /clip/i];
const MEME_TERMS = ["prank", "meme", "ngakak", "lucu", "challenge", "reaction", "anime", "gameplay"];

function filterQualityShorts(items = []) {
  const seenTitles = new Set();
  return items.filter((item) => {
    const title = normalize(item.title);
    if (!title || title.length < 8) return false;
    if (seenTitles.has(title)) return false;
    seenTitles.add(title);
    if (SPAM_CHANNEL_PATTERNS.some((pattern) => pattern.test(item.channel || ""))) return false;
    const memeCount = MEME_TERMS.filter((term) => title.includes(term)).length;
    const productSignal = Number(item.product_confidence || item.commercial_intent || item.product_intent_score || 0);
    if (memeCount >= 1 && productSignal < 60) return false;
    if (Number(item.views || 0) < 250 && productSignal < 50) return false;
    return true;
  });
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^\w\s\u00c0-\u024f\u1e00-\u1eff]/g, " ").replace(/\s+/g, " ").trim();
}

module.exports = {
  filterQualityShorts
};
