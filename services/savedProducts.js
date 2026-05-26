const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SAVE_FILE = path.join(DATA_DIR, "saved-products.json");

async function listSavedProducts() {
  return readSavedProducts();
}

async function saveProduct(product) {
  const items = await readSavedProducts();
  const normalized = normalizeProduct(product);
  const existingIndex = items.findIndex((item) => item.id === normalized.id);

  if (existingIndex >= 0) {
    items[existingIndex] = { ...items[existingIndex], ...normalized };
  } else {
    items.unshift(normalized);
  }

  await writeSavedProducts(items);
  return normalized;
}

async function deleteSavedProduct(id) {
  const items = await readSavedProducts();
  const next = items.filter((item) => item.id !== id);
  await writeSavedProducts(next);
  return { deleted: items.length !== next.length };
}

async function readSavedProducts() {
  try {
    const raw = await fs.readFile(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSavedProducts(items) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SAVE_FILE, JSON.stringify(items, null, 2), "utf8");
}

function normalizeProduct(product) {
  const source = String(product.source || "unknown");
  const url = String(product.url || "");
  const title = String(product.title || product.name || "Untitled item");
  return {
    id: product.id || `${source}:${url || title}`.toLowerCase(),
    source,
    title,
    name: product.name || title,
    url,
    image: product.image || product.thumbnail || "",
    label: product.label || "LOW",
    score: Number(product.score || 0),
    price: product.price || "",
    channel: product.channel || product.username || product.shopName || "",
    savedAt: product.savedAt || new Date().toISOString(),
    raw: product
  };
}

module.exports = {
  deleteSavedProduct,
  listSavedProducts,
  saveProduct
};
