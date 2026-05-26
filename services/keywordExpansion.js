const EXPANSION_PRESETS = [
  {
    match: ["fashion pria", "pria", "cowok"],
    keywords: [
      "outfit cowok viral",
      "celana cargo pria viral",
      "kaos oversized pria",
      "jaket pria kekinian",
      "sepatu pria viral"
    ]
  },
  {
    match: ["fashion wanita", "wanita"],
    keywords: [
      "outfit wanita viral",
      "dress wanita kekinian",
      "tas wanita viral",
      "sepatu wanita viral",
      "baju wanita terlaris"
    ]
  },
  {
    match: ["gadget", "tech"],
    keywords: [
      "gadget viral",
      "tech gadget murah",
      "aksesoris gadget viral",
      "alat elektronik mini",
      "gadget unik viral"
    ]
  },
  {
    match: ["dapur", "kitchen"],
    keywords: [
      "alat dapur viral",
      "kitchen gadget viral",
      "alat masak unik",
      "perlengkapan dapur murah",
      "produk dapur terlaris"
    ]
  },
  {
    match: ["rumah", "home"],
    keywords: [
      "alat rumah tangga viral",
      "produk rumah tangga unik",
      "alat pembersih viral",
      "home improvement finds",
      "perlengkapan rumah terlaris"
    ]
  }
];

function expandKeyword(keyword, max = 5) {
  const clean = normalize(keyword);
  if (!clean) return [];

  const preset = EXPANSION_PRESETS.find((entry) => entry.match.some((needle) => clean.includes(needle)));
  const suggestions = preset ? preset.keywords : genericExpansion(clean);
  return unique([keyword, ...suggestions]).slice(0, max);
}

function genericExpansion(keyword) {
  return [
    `${keyword} viral`,
    `${keyword} murah`,
    `${keyword} unik`,
    `${keyword} terlaris`,
    `${keyword} terbaru`
  ];
}

function unique(items) {
  const seen = new Set();
  return items
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

module.exports = {
  expandKeyword
};
