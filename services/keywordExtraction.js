const STOPWORDS = new Set([
  "yang", "dan", "atau", "ini", "itu", "buat", "bikin", "jadi", "cuma", "banget",
  "viral", "fyp", "shorts", "short", "youtube", "indonesia", "review", "unboxing",
  "beli", "murah", "terbaru", "terbaik", "wajib", "punya", "kamu", "aku", "kita",
  "mereka", "dengan", "untuk", "dari", "dalam", "paling", "cocok", "pakai", "cara",
  "harga", "produk", "rekomendasi", "barang", "haul", "checkout", "keranjang"
]);

const PRODUCT_HINTS = new Set([
  "alat", "rak", "sepatu", "tas", "dompet", "lampu", "kipas", "botol", "kotak", "box",
  "organizer", "holder", "stand", "charger", "case", "casing", "kabel", "bantal", "meja",
  "kursi", "panci", "wajan", "pisau", "sendok", "gelas", "jaket", "kaos", "celana",
  "hoodie", "jam", "kacamata", "mainan", "karpet", "sprei", "humidifier", "blender",
  "dapur", "motor", "mobil", "hp", "laptop", "keyboard", "mouse", "sandal", "skincare",
  "parfum", "helm", "lemari", "gantungan", "sabun", "serum", "masker", "speaker"
]);

function extractProductKeywords(title, fallback = "") {
  const words = tokenize(title);
  const phrases = [];

  for (let size = 4; size >= 2; size -= 1) {
    for (let i = 0; i <= words.length - size; i += 1) {
      const part = words.slice(i, i + size);
      if (part.length < 2) continue;
      const hasHint = part.some((word) => PRODUCT_HINTS.has(word));
      if (hasHint || phrases.length < 2) phrases.push(part.join(" "));
    }
  }

  for (const word of words) {
    if (PRODUCT_HINTS.has(word)) phrases.push(word);
  }

  if (fallback) phrases.push(...fallback.split(",").map((item) => item.trim()));

  return dedupe(phrases.flatMap(expandPhrase))
    .filter((phrase) => phrase.length >= 4)
    .slice(0, 6);
}

function tokenize(value) {
  return normalize(value)
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !STOPWORDS.has(word))
    .filter((word) => !/^\d+$/.test(word));
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

function expandPhrase(phrase) {
  const clean = normalize(phrase);
  const output = [clean];
  if (clean.includes("rak") && clean.includes("sepatu")) output.push("rak sepatu", "rak lipat", "organizer sepatu");
  if (clean.includes("lipat")) output.push(clean.replace(/\blipat\b/g, "").trim());
  if (clean.includes("case") || clean.includes("casing")) output.push("case hp", "aksesoris hp");
  if (clean.includes("dapur")) output.push("alat dapur", "kitchen gadget");
  if (clean.includes("sepatu")) output.push("sepatu viral");
  return output.filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalize(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  extractProductKeywords,
  tokenize
};
