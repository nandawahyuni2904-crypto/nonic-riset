const fs = require("node:fs");
const path = require("node:path");
const { parseCount } = require("../services/scoring");

const SEARCH_TIMEOUT = Number(process.env.SHOPEE_TIMEOUT_MS || process.env.SCRAPER_TIMEOUT_MS || 30000);
const DEBUG_DIR = path.join(__dirname, "..", "debug");
const SHOPEE_COOKIE_PATH = path.join(__dirname, "..", "data", "shopee-cookies.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
let sharedBrowserPromise;

async function scrapeShopeeSearch(keyword, options = {}) {
  const limit = clamp(Number(options.limit || 20), 5, 20);
  const debug = createDebug("Shopee");
  const state = {
    method1Status: "",
    method1Error: "",
    method1RawCount: 0,
    method2Error: "",
    method3Error: "",
    lastUrl: "",
    sampleHtmlText: "",
    screenshotPath: "",
    cookieCount: 0,
    hasCookies: false
  };
  const cookies = loadShopeeCookies();
  state.cookieCount = cookies.length;
  state.hasCookies = Boolean(cookies.length);
  if (!cookies.length) {
    debug("Cookie Shopee tidak ditemukan, lanjut scrape public search tanpa login.");
  }

  const jsonProducts = await scrapeShopeeJson(keyword, limit, debug, state, cookies);
  const validJsonProducts = finalizeProducts(jsonProducts, limit, debug, "internal-json", false);
  if (validJsonProducts.length) return validJsonProducts;

  const browserProducts = await scrapeShopeeWithPlaywright(keyword, limit, debug, state, cookies);
  const networkProducts = browserProducts.networkProducts;
  const validNetworkProducts = finalizeProducts(networkProducts, limit, debug, "network-capture", false);
  if (validNetworkProducts.length) return validNetworkProducts;

  state.method2Error = state.method2Error || (networkProducts.length ? "Network capture ada item, tapi tidak ada produk lengkap." : "Tidak ada response network search_items tertangkap.");
  const products = finalizeProducts(browserProducts.domProducts, limit, debug, "visual-card-fallback", false);
  if (!products.length) {
    const error = new Error("Shopee belum berhasil mengambil data lengkap.");
    error.debug = state;
    throw error;
  }
  return products;
}

async function scrapeShopeeJson(keyword, limit, debug, state, cookies) {
  const endpoints = buildSearchEndpoints(keyword, limit);
  const cookie = serializeCookies(cookies);
  const products = [];

  for (const endpoint of endpoints) {
    debug(`Endpoint Shopee: ${endpoint}`);
    state.lastUrl = endpoint;
    const result = await fetchJsonWithStatus(endpoint, {
      headers: {
        accept: "application/json",
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        referer: `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`,
        "user-agent": USER_AGENT,
        "x-api-source": "pc",
        "x-requested-with": "XMLHttpRequest",
        ...(cookie ? { cookie } : {})
      }
    }).catch((error) => {
      debug(`JSON endpoint gagal: ${error.message}`);
      state.method1Error = error.message;
      return null;
    });
    state.method1Status = result ? String(result.status) : state.method1Status;
    const data = result?.data || null;

    const rawItems = extractRawItems(data);
    state.method1RawCount += rawItems.length;
    debug(`Jumlah raw item JSON: ${rawItems.length}`);
    products.push(...rawItems.map(normalizeApiProduct).filter(Boolean));
    if (products.length >= limit) break;
  }

  return products;
}

async function scrapeShopeeWithPlaywright(keyword, limit, debug, state, cookies) {
  const searchUrl = `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`;
  const networkProducts = [];
  let browser;
  let context;
  let page;

  try {
    const playwright = loadPlaywright();
    browser = await launchBrowser(playwright, "Shopee");
    context = await browser.newContext({
      locale: "id-ID",
      timezoneId: "Asia/Jakarta",
      viewport: { width: 1366, height: 900 },
      userAgent: USER_AGENT
    });
    if (cookies.length) await context.addCookies(cookies);
    await applyStealth(context);
    page = await context.newPage();
    page.setDefaultTimeout(SEARCH_TIMEOUT);
    page.on("response", async (response) => {
      const responseUrl = response.url();
      if (!/search_items|search\/search_items/.test(responseUrl)) return;
      try {
        debug(`Network capture URL: ${responseUrl} status=${response.status()}`);
        state.lastUrl = responseUrl;
        const data = await response.json();
        const rawItems = extractRawItems(data);
        debug(`Network raw item count: ${rawItems.length}`);
        networkProducts.push(...rawItems.map(normalizeApiProduct).filter(Boolean));
      } catch (error) {
        debug(`Network JSON parse gagal: ${error.message}`);
        state.method2Error = error.message;
      }
    });
    debug(`Open URL fallback: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT });
    await waitForProducts(page, debug);
    await scrollForProducts(page, debug);
    await page.waitForTimeout(1500);
    state.sampleHtmlText = cleanText(await page.locator("body").innerText({ timeout: 1500 }).catch(() => "")).slice(0, 700);
    state.screenshotPath = await saveScreenshot(page, "shopee.png", debug).catch(() => "");

    const rawProducts = await extractDomProducts(page, limit, debug, state);
    debug(`Jumlah raw item DOM: ${rawProducts.length}`);
    return {
      networkProducts,
      domProducts: rawProducts
    };
  } catch (error) {
    if (page) state.screenshotPath = await saveScreenshot(page, "shopee.png", debug).catch(() => state.screenshotPath);
    debug(`Playwright fallback gagal: ${error.message}`);
    state.method3Error = error.message;
    return {
      networkProducts,
      domProducts: []
    };
  } finally {
    if (context) await context.close().catch((error) => debug(`Context close error: ${error.message}`));
    debug("Browser kept in pool");
  }
}

function buildSearchEndpoints(keyword, limit) {
  const encoded = encodeURIComponent(keyword);
  return [
    `https://shopee.co.id/api/v4/search/search_items?by=relevancy&keyword=${encoded}&limit=${limit}&newest=0&order=desc&page_type=search`,
    `https://shopee.co.id/api/v4/search/search_items?by=relevancy&keyword=${encoded}&limit=${limit}&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2`,
    `https://shopee.co.id/api/v2/search_items/?by=relevancy&keyword=${encoded}&limit=${limit}&newest=0&order=desc&page_type=search`
  ];
}

async function bootstrapCookie(keyword, debug) {
  const url = `https://shopee.co.id/search?keyword=${encodeURIComponent(keyword)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "user-agent": USER_AGENT
      },
      signal: controller.signal
    });
    const cookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    debug(`Cookie bootstrap status=${response.status}, cookies=${cookies.length}`);
    return cookies.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
  } catch (error) {
    debug(`Cookie bootstrap gagal: ${error.message}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function loadShopeeCookies() {
  try {
    if (!fs.existsSync(SHOPEE_COOKIE_PATH)) return [];
    const cookies = JSON.parse(fs.readFileSync(SHOPEE_COOKIE_PATH, "utf8"));
    if (!Array.isArray(cookies)) return [];
    return cookies
      .filter((cookie) => cookie.name && cookie.value)
      .map((cookie) => ({
        ...cookie,
        domain: cookie.domain || ".shopee.co.id",
        path: cookie.path || "/"
      }));
  } catch {
    return [];
  }
}

function serializeCookies(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function extractRawItems(data) {
  if (!data) return [];
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data?.items)) return data.data.items;
  if (Array.isArray(data.data?.sections)) return data.data.sections.flatMap((section) => section.items || []);
  return [];
}

function normalizeApiProduct(raw) {
  const item = raw?.item_basic || raw?.item || raw?.ads_item || raw;
  if (!item || typeof item !== "object") return null;
  const itemid = item.itemid || item.item_id;
  const shopid = item.shopid || item.shop_id;
  const name = cleanText(item.name || item.title);
  const price = formatShopeePrice(pickPrice(item));
  const image = formatShopeeImage(item.image || item.image_url || item.images?.[0]);
  const url = normalizeUrl(item.url || item.product_url) || buildProductUrl(name, shopid, itemid);

  return {
    name,
    price,
    soldCount: Number(item.historical_sold || item.sold || item.monthly_sold || item.global_sold_count || 0) || parseCount(item.soldText),
    rating: roundRating(item.item_rating?.rating_star || item.rating_star || item.rating || 0),
    reviewCount: extractReviewCount(item),
    image,
    shopName: cleanText(item.shop_name || item.shopname || item.shop_location || item.shopLocation || ""),
    url,
    shopid,
    itemid
  };
}

function pickPrice(item) {
  return item.price || item.price_min || item.price_before_discount || item.priceText || item.price_text || item.price_min_before_discount || "";
}

function extractReviewCount(item) {
  const direct = item.cmt_count || item.review_count || item.reviewCount || item.item_rating?.rcount_with_context || 0;
  if (Number(direct)) return Number(direct);
  const ratingCount = item.item_rating?.rating_count || item.rating_count;
  if (Array.isArray(ratingCount)) return Number(ratingCount[0] || 0) || ratingCount.reduce((sum, value) => sum + (Number(value) || 0), 0);
  return parseCount(item.reviewText || item.review_count_text || "");
}

function finalizeProducts(rawProducts, limit, debug, source, throwOnEmpty = true) {
  const discard = {};
  const products = dedupe(rawProducts.map((item) => normalizeProduct(item, discard)).filter(Boolean), (item) => item.url || item.name).slice(0, limit);
  debug(`Extraction source: ${source}`);
  debug(`Jumlah raw item: ${rawProducts.length}`);
  debug(`Jumlah valid product: ${products.length}`);
  debug(`Alasan item dibuang: ${JSON.stringify(discard)}`);
  debug(`Contoh produk: ${JSON.stringify(products.slice(0, 3).map((item) => ({
    name: item.name,
    price: item.price,
    soldCount: item.soldCount,
    rating: item.rating,
    reviewCount: item.reviewCount,
    image: Boolean(item.image),
    shopName: item.shopName,
    url: item.url
  })))}`);
  if (!products.length && throwOnEmpty) throw new Error("Shopee belum berhasil mengambil data lengkap.");
  return products;
}

function normalizeProduct(item, discard = {}) {
  const name = cleanText(item.name);
  const price = cleanText(item.price);
  const image = formatShopeeImage(item.image);
  const url = normalizeUrl(item.url) || buildProductUrl(name, item.shopid, item.itemid);

  if (!isValidName(name)) return discardProduct(discard, "missing_or_invalid_name");
  if (!price) return discardProduct(discard, "missing_price");
  if (!url) return discardProduct(discard, "missing_url");

  return {
    name,
    price,
    soldCount: Number(item.soldCount || 0) || parseCount(item.soldText),
    rating: roundRating(item.rating),
    reviewCount: Number(item.reviewCount || 0) || parseCount(item.reviewText),
    image,
    shopName: cleanText(item.shopName),
    url
  };
}

function discardProduct(discard, reason) {
  discard[reason] = (discard[reason] || 0) + 1;
  return null;
}

async function waitForProducts(page, debug) {
  const selector = ['a[href*="-i."]', 'a[href*="/product/"]', "[data-sqe='item']", ".shopee-search-item-result__item"].join(", ");
  try {
    await page.waitForSelector(selector, { timeout: Math.min(SEARCH_TIMEOUT, 7000) });
    debug(`waitForSelector success: ${selector}`);
  } catch (error) {
    debug(`waitForSelector timeout: ${error.message}`);
  }
}

async function scrollForProducts(page, debug) {
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(1200);
    const count = await page.locator('a[href*="-i."], a[href*="/product/"]').count().catch(() => 0);
    debug(`Scroll ${i + 1}: product link count=${count}`);
  }
}

async function extractDomProducts(page, limit, debug, state = {}) {
  const result = await page.evaluate((maxItems) => {
    const anchors = Array.from(new Set(Array.from(document.querySelectorAll([
      'a[href*="-i."]',
      'a[href*="/product/"]',
      'a[href*="sp_atk"]',
      "[data-sqe='item'] a[href]",
      ".shopee-search-item-result__item a[href]",
      "a[href]"
    ].join(",")))));
    const seen = new Set();
    const items = [];

    for (const anchor of anchors) {
      const url = normalizeUrl(anchor.href || anchor.getAttribute("href") || "");
      if (!url || seen.has(url)) continue;
      const card = anchor.closest("[data-sqe='item']") || anchor.closest(".shopee-search-item-result__item") || anchor.closest("li") || anchor.closest("div") || anchor;
      const text = normalize(card.innerText || anchor.innerText || anchor.getAttribute("aria-label") || "");
      const image = extractImage(card);
      const name = extractName(text, anchor, card);
      const price = extractPrice(text);

      if (!name || (!price && !url)) continue;
      seen.add(url);
      items.push({
        name,
        price,
        url,
        image,
        soldText: extractSold(text),
        rating: extractRating(text),
        reviewText: extractReview(text),
        shopName: extractShop(text)
      });
      if (items.length >= maxItems) break;
    }
    return { anchorCount: anchors.length, items };

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }
    function normalizeUrl(href) {
      if (!href) return "";
      const url = href.startsWith("http") ? href : `https://shopee.co.id${href}`;
      if (/-i\.\d+\.\d+|\/product\/\d+\/\d+|sp_atk=/.test(url)) return url;
      return "";
    }
    function extractImage(card) {
      const img = card.querySelector("img[src], img[data-src], img[srcset]");
      const srcset = normalize(img?.getAttribute("srcset") || "");
      const src = normalize(img?.src || img?.getAttribute("data-src") || srcset.split(/\s+/)[0] || "");
      if (!src || src.startsWith("data:")) return "";
      if (src.startsWith("//")) return `https:${src}`;
      return src;
    }
    function extractName(text, anchor, card) {
      const attrs = [anchor.getAttribute("aria-label"), anchor.getAttribute("title"), card.querySelector("img")?.getAttribute("alt")]
        .map(normalize)
        .filter(Boolean);
      const fromAttr = attrs.find((item) => item.length >= 5 && !/^gambar/i.test(item));
      if (fromAttr) return cleanName(fromAttr);
      return cleanName(text.split(/Rp\s?[\d.]+/i)[0] || text);
    }
    function cleanName(value) {
      return normalize(value).replace(/\bAd\b|\bIklan\b|Star\+|Mall/gi, " ").replace(/\s+/g, " ").trim().slice(0, 180);
    }
    function extractPrice(text) {
      const match = text.match(/Rp\s?[\d.]+(?:\s?-\s?Rp\s?[\d.]+)?/i);
      return normalize(match?.[0] || "");
    }
    function extractSold(text) {
      const match = text.match(/([\d.,]+\s?(?:rb|ribu|jt|juta|k|m)?)\s*(?:terjual|sold)/i);
      return normalize(match?.[1] || "");
    }
    function extractRating(text) {
      const match = text.match(/([1-5](?:[.,]\d)?)\s*(?:\/\s*5|bintang|star)/i);
      return match ? Number(match[1].replace(",", ".")) : 0;
    }
    function extractReview(text) {
      const match = text.match(/([\d.,]+\s?(?:rb|ribu|jt|juta|k|m)?)\s*(?:ulasan|review|reviews|penilaian)/i);
      return normalize(match?.[1] || "");
    }
    function extractShop(text) {
      const parts = text.split(/[\n|•]/).map(normalize).filter(Boolean);
      return parts.find((part) => /official|store|shop|toko|mall/i.test(part) && part.length < 80) || "";
    }
  }, limit * 2);
  debug(`Anchor candidates: ${result.anchorCount}`);
  state.method3Error = result.items.length ? state.method3Error : `DOM fallback menemukan ${result.anchorCount} anchor, tapi 0 produk lengkap.`;
  return result.items;
}

function formatShopeePrice(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  if (/rp|idr|\$|-/i.test(raw)) return raw.replace(/\s+/g, " ");
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const rupiah = numeric >= 100000 ? numeric / 100000 : numeric;
  return `Rp${Math.round(rupiah).toLocaleString("id-ID")}`;
}

function formatShopeeImage(value) {
  const raw = cleanText(value);
  if (!raw || raw.startsWith("data:")) return "";
  if (raw.startsWith("http")) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (raw.includes("/")) return raw;
  return `https://down-id.img.susercontent.com/file/${raw}`;
}

function buildProductUrl(name, shopid, itemid) {
  if (!shopid || !itemid) return "";
  const slug = cleanText(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "produk";
  return `https://shopee.co.id/${slug}-i.${shopid}.${itemid}`;
}

function normalizeUrl(url) {
  const value = cleanText(url);
  if (!value) return "";
  if (value.startsWith("http")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `https://shopee.co.id${value}`;
  return "";
}

function roundRating(value) {
  const number = Number(String(value || 0).replace(",", "."));
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0;
}

function isValidName(name) {
  if (!name || name.length < 4) return false;
  return !/(shopee_|settings|domain|language|config|__|csrf|cookie|session|navbar|footer)/i.test(name);
}

async function fetchJsonWithStatus(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    if (!response.ok) {
      const bodyHint = typeof data?.raw === "string" ? ` body=${data.raw.slice(0, 160)}` : "";
      throw new Error(`HTTP ${response.status}${bodyHint}`);
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    throw new Error("Playwright belum terinstall. Jalankan: npm install && npx playwright install chromium");
  }
}

async function launchBrowser(playwright, label) {
  if (sharedBrowserPromise) {
    const existing = await sharedBrowserPromise.catch(() => null);
    if (existing?.isConnected()) return existing;
    sharedBrowserPromise = null;
  }
  const launchOptions = {
    headless: true,
    proxy: process.env.SCRAPER_PROXY_URL ? { server: process.env.SCRAPER_PROXY_URL } : undefined,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"]
  };
  console.log(`[${label} scraper] Launch Chromium headless=true`);
  try {
    const executablePath = findWindowsBrowser();
    if (executablePath) {
      console.log(`[${label} scraper] Use local browser: ${executablePath}`);
      sharedBrowserPromise = playwright.chromium.launch({ ...launchOptions, executablePath });
      return await sharedBrowserPromise;
    }
    sharedBrowserPromise = playwright.chromium.launch(launchOptions);
    return await sharedBrowserPromise;
  } catch (error) {
    console.log(`[${label} scraper] Chromium launch failed: ${error.message}`);
    throw error;
  }
}

async function applyStealth(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["id-ID", "id", "en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
}

async function saveScreenshot(page, fileName, debug) {
  if (isReadOnlyRuntime()) {
    debug("Screenshot skipped in production/serverless runtime.");
    return "";
  }
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const target = path.join(DEBUG_DIR, fileName);
  await page.screenshot({ path: target, fullPage: true });
  debug(`Screenshot saved: ${target}`);
  return target;
}

function isReadOnlyRuntime() {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

function dedupe(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(getKey(item) || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createDebug(label) {
  return (message) => console.log(`[${label} scraper] ${message}`);
}

function findWindowsBrowser() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  scrapeShopeeSearch
};
