const fs = require("node:fs");
const path = require("node:path");
const { parseCount } = require("../services/scoring");

const SEARCH_TIMEOUT = Number(process.env.TIKTOK_SHOP_TIMEOUT_MS || process.env.TIKTOK_TIMEOUT_MS || 10000);
const DEBUG_DIR = path.join(__dirname, "..", "debug");
const SESSION_PATH = process.env.TIKTOK_SHOP_STORAGE_STATE || path.join(__dirname, "..", "data", "tiktok-shop-session.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
let sharedBrowserPromise;

async function scrapeTikTokSearch(keyword, options = {}) {
  return scrapeTikTokShopProducts(keyword, options);
}

async function scrapeTikTokShopProducts(keyword, options = {}) {
  const limit = clamp(Number(options.limit || 8), 5, 8);
  const playwright = loadPlaywright();
  const browser = await launchBrowser(playwright, "TikTok Shop");
  const debug = createDebug("TikTok Shop");
  let context;
  let page;

  try {
    context = await browser.newContext({
      locale: "id-ID",
      timezoneId: "Asia/Jakarta",
      viewport: { width: 1366, height: 900 },
      userAgent: USER_AGENT,
      storageState: fs.existsSync(SESSION_PATH) ? SESSION_PATH : undefined
    });
    await applyStealth(context);
    page = await context.newPage();
    page.setDefaultTimeout(SEARCH_TIMEOUT);

    const products = await scrapeShopPages(page, keyword, limit, debug);
    if (!products.length) {
      throw new Error("TikTok Shop membutuhkan login atau membatasi akses.");
    }
    return normalizeProducts(products).slice(0, limit);
  } catch (error) {
    if (page) await saveScreenshot(page, "tiktok-shop.png", debug).catch(() => {});
    debug(`ERROR: ${error.message}`);
    throw new Error("TikTok Shop membutuhkan login atau membatasi akses.");
  } finally {
    if (context) await context.close().catch((error) => debug(`Context close error: ${error.message}`));
    debug("Browser kept in pool");
  }
}

async function scrapeShopPages(page, keyword, limit, debug) {
  const urls = [
    `https://www.tiktok.com/shop/s/${encodeURIComponent(keyword)}`,
    `https://shop.tiktok.com/search?keyword=${encodeURIComponent(keyword)}`,
    `https://www.tiktok.com/search/shop?q=${encodeURIComponent(keyword)}`
  ];
  const allItems = [];

  for (const url of urls) {
    try {
      debug(`Open URL: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: SEARCH_TIMEOUT });
      await waitNetworkIdle(page, debug);
      await saveScreenshot(page, "tiktok-shop.png", debug);

      const accessBlocked = await looksBlocked(page);
      if (accessBlocked) {
        debug("Login/captcha wall detected");
        throw new Error("login wall");
      }

      await waitForAnySelector(page, [
        "img[src]",
        "a[href*='/shop/']",
        "a[href*='/product/']",
        "script[type='application/json']"
      ], 3500, debug);

      await scrollForResults(page, limit, debug);
      const counts = await selectorCounts(page, {
        links: "a[href]",
        images: "img[src], img[data-src]",
        productLinks: "a[href*='/shop/'], a[href*='/product/'], a[href*='shop.tiktok.com']",
        scripts: "script"
      });
      debug(`Counts: ${JSON.stringify(counts)}`);

      const jsonItems = await extractProductsFromScripts(page, limit, debug);
      const domItems = await extractProductsFromDom(page, keyword, limit, debug);
      allItems.push(...jsonItems, ...domItems);
      debug(`Valid products so far=${allItems.length}`);
      if (allItems.length >= limit) break;
    } catch (error) {
      debug(`Source failed: ${url} | ${error.message}`);
    }
  }

  const products = dedupe(allItems.filter(isValidProduct), (item) => item.url || `${item.name}:${item.price}`);
  debug(`Valid after filter=${products.length}`);
  debug(`Sample: ${JSON.stringify(products.slice(0, 3).map((item) => ({ name: item.name, price: item.price, url: item.url, image: Boolean(item.image) })))}`);
  return products.slice(0, limit);
}

async function extractProductsFromScripts(page, limit, debug) {
  try {
    const items = await page.evaluate((maxItems) => {
      const scripts = Array.from(document.scripts).map((script) => script.textContent || "").filter(Boolean);
      const results = [];
      const seen = new Set();

      for (const text of scripts) {
        if (!/item_id|product_id|productId|shop_id|price|sold|rating|commission|image/i.test(text)) continue;
        collectFromText(text, results, seen, maxItems);
        if (results.length >= maxItems) break;
      }
      return results.slice(0, maxItems);

      function collectFromText(text, output, seenSet, max) {
        const nameMatches = [...text.matchAll(/"((?:product_)?name|title)"\s*:\s*"([^"]{5,160})"/gi)];
        for (const match of nameMatches) {
          const name = decode(match[2]);
          if (!isProductName(name)) continue;
          const start = Math.max(0, match.index - 2500);
          const end = Math.min(text.length, match.index + 3500);
          const chunk = text.slice(start, end);
          const id = pick(chunk, [/"(?:product_id|productId|item_id|itemId)"\s*:\s*"?(\d+)/i]);
          const shopId = pick(chunk, [/"(?:shop_id|shopId)"\s*:\s*"?(\d+)/i]);
          const image = normalizeImage(pick(chunk, [
            /"(?:image|img|cover|thumb|thumbnail|uri)"\s*:\s*"([^"]+)"/i,
            /"(?:url_list|urlList)"\s*:\s*\[\s*"([^"]+)"/i
          ]));
          const priceRaw = pick(chunk, [
            /"(?:price|sale_price|salePrice|min_price|minPrice)"\s*:\s*"?([\d.]+)/i,
            /"(?:price_text|priceText|display_price|displayPrice)"\s*:\s*"([^"]+)"/i
          ]);
          const soldRaw = pick(chunk, [/"(?:sold|sold_count|soldCount|sales|sales_volume)"\s*:\s*"?([\d.,A-Za-z\s]+)/i]);
          const ratingRaw = pick(chunk, [/"(?:rating|rate|star)"\s*:\s*"?([\d.]+)/i]);
          const shopName = decode(pick(chunk, [/"(?:shop_name|shopName|seller_name|sellerName)"\s*:\s*"([^"]+)"/i]));
          const commission = decode(pick(chunk, [/"(?:commission|commission_rate|commissionRate)"\s*:\s*"?(.*?)["},]/i]));
          const url = pick(chunk, [/"(?:product_url|productUrl|share_url|shareUrl|url)"\s*:\s*"([^"]+)"/i]) || buildUrl(id, shopId);
          const key = `${id || name}:${priceRaw}`;
          if (!seenSet.has(key)) {
            seenSet.add(key);
            output.push({ name, price: priceRaw, soldText: soldRaw, rating: ratingRaw, shopName, commission, image, url, productId: id, shopId });
            if (output.length >= max) break;
          }
        }
      }
      function pick(text, patterns) {
        for (const pattern of patterns) {
          const match = text.match(pattern);
          if (match?.[1]) return decode(match[1]);
        }
        return "";
      }
      function decode(value) {
        try {
          return String(value || "").replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/\\"/g, '"').trim();
        } catch {
          return String(value || "").trim();
        }
      }
      function normalizeImage(value) {
        const decoded = decode(value);
        if (!decoded || decoded.startsWith("data:")) return "";
        if (decoded.startsWith("//")) return `https:${decoded}`;
        return decoded;
      }
      function buildUrl(productId, shopId) {
        if (!productId) return "";
        const query = shopId ? `?shop_id=${shopId}` : "";
        return `https://www.tiktok.com/shop/product/${productId}${query}`;
      }
      function isProductName(value) {
        if (!value || value.length < 5) return false;
        return !/tiktok|login|captcha|cookie|privacy|creative center|dashboard/i.test(value);
      }
    }, limit);
    debug(`Script parser products=${items.length}`);
    return items;
  } catch (error) {
    debug(`Script parser failed: ${error.message}`);
    return [];
  }
}

async function extractProductsFromDom(page, keyword, limit, debug) {
  try {
    const data = await page.evaluate(({ query, maxItems }) => {
      const cards = Array.from(document.querySelectorAll("article, li, a[href], [class*='product'], [class*='Product'], [data-e2e*='product']"))
        .filter((node) => !node.closest("header, footer, nav, aside"));
      const tokens = tokenize(query);
      const results = [];
      const seen = new Set();

      for (const card of cards) {
        const text = normalize(card.innerText || card.textContent || "");
        const image = card.querySelector("img[src], img[data-src]");
        const link = card.tagName === "A" ? card : card.querySelector("a[href]");
        const name = pickName(text, link);
        const price = pickPrice(text);
        const url = normalizeUrl(link?.href || link?.getAttribute("href") || "");
        const img = normalizeUrl(image?.src || image?.getAttribute("data-src") || "");
        const soldText = pick(text, /([\d.,]+\s?(?:rb|ribu|jt|juta|k|m)?\s*(?:terjual|sold))/i);
        const rating = pick(text, /(?:rating|bintang)?\s*([0-5](?:[.,]\d)?)/i);
        const commission = pick(text, /(komisi\s*[\d.,]+%|commission\s*[\d.,]+%)/i);
        const shopName = pickShop(text);
        const relevance = tokens.length ? tokens.filter((token) => name.toLowerCase().includes(token)).length : 1;
        const key = `${name}:${url}`;
        if (!seen.has(key) && isValid({ name, price, url, img, relevance })) {
          seen.add(key);
          results.push({ name, price, soldText, rating, shopName, commission, image: img, url });
          if (results.length >= maxItems) break;
        }
      }
      return { candidateCount: cards.length, items: results };

      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }
      function normalizeUrl(value) {
        const src = normalize(value);
        if (!src || src.startsWith("data:")) return "";
        if (src.startsWith("//")) return `https:${src}`;
        if (src.startsWith("/")) return `https://www.tiktok.com${src}`;
        return src;
      }
      function tokenize(value) {
        return normalize(value).toLowerCase().split(/\s+/).filter((word) => word.length > 2);
      }
      function pickName(text, link) {
        const title = normalize(link?.getAttribute("title") || link?.getAttribute("aria-label") || "");
        if (isProductName(title)) return title.slice(0, 140);
        return text.split(/Rp|IDR|\$|Terjual|Sold|Rating|Komisi|Commission/i).map(normalize).find(isProductName)?.slice(0, 140) || "";
      }
      function pickPrice(text) {
        return pick(text, /(Rp\s?[\d.,]+(?:\s?-\s?Rp\s?[\d.,]+)?|IDR\s?[\d.,]+|\$\s?[\d.,]+)/i);
      }
      function pickShop(text) {
        const parts = text.split(/[\n|•]/).map(normalize).filter(Boolean);
        return parts.find((part) => /shop|store|official|seller|toko/i.test(part) && part.length < 80) || "";
      }
      function pick(text, pattern) {
        const match = text.match(pattern);
        return normalize(match?.[1] || "");
      }
      function isProductName(value) {
        if (!value || value.length < 5 || value.length > 180) return false;
        return !/login|captcha|verify|privacy|cookie|tiktok shop|for you|following|home/i.test(value);
      }
      function isValid(item) {
        if (!isProductName(item.name)) return false;
        if (!item.img) return false;
        if (!item.price && !isProductUrl(item.url)) return false;
        if (tokens.length && item.relevance === 0 && results.length > 2) return false;
        return true;
      }
      function isProductUrl(url) {
        return /shop|product|item/i.test(url || "");
      }
    }, { query: keyword, maxItems: limit });
    debug(`DOM candidates=${data.candidateCount}, products=${data.items.length}`);
    return data.items;
  } catch (error) {
    debug(`DOM parser failed: ${error.message}`);
    return [];
  }
}

function normalizeProducts(items) {
  return items.map((item) => {
    const soldCount = parseCount(item.soldText || item.soldCount || item.sold || "");
    const rating = Number(String(item.rating || "").replace(",", ".")) || 0;
    return {
      name: cleanName(item.name),
      title: cleanName(item.name),
      price: normalizePrice(item.price),
      soldCount,
      rating,
      shopName: cleanName(item.shopName || item.shop || ""),
      commission: normalizeCommission(item.commission),
      image: normalizeImage(item.image),
      thumbnail: normalizeImage(item.image),
      url: normalizeUrl(item.url),
      productId: item.productId || "",
      shopId: item.shopId || "",
      source: "tiktok-shop"
    };
  }).filter(isValidProduct);
}

function isValidProduct(item) {
  if (!item?.name || item.name.length < 5) return false;
  if (/login|captcha|verify|privacy|cookie|creative center|dashboard/i.test(item.name)) return false;
  if (!item.image) return false;
  if (!item.price && !item.url) return false;
  return true;
}

function normalizePrice(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/rp|idr|\$|-/i.test(raw)) return raw.replace(/\s+/g, " ");
  const number = Number(raw);
  if (!Number.isFinite(number)) return raw;
  const normalized = number > 1_000_000 ? number / 100000 : number;
  return `Rp ${new Intl.NumberFormat("id-ID").format(Math.round(normalized))}`;
}

function normalizeCommission(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.includes("%") || /komisi|commission/i.test(raw)) return raw;
  const number = Number(raw);
  if (!Number.isFinite(number)) return raw;
  return number <= 1 ? `${Math.round(number * 100)}%` : `${number}%`;
}

function normalizeImage(value) {
  const src = String(value || "").trim();
  if (!src || src.startsWith("data:")) return "";
  if (src.startsWith("//")) return `https:${src}`;
  return src;
}

function normalizeUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.tiktok.com${url}`;
  return url;
}

function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
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

  const headless = process.env.SCRAPER_HEADLESS === "false" ? false : true;
  const launchOptions = {
    headless,
    proxy: process.env.SCRAPER_PROXY_URL ? { server: process.env.SCRAPER_PROXY_URL } : undefined,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--no-sandbox"
    ]
  };

  try {
    console.log(`[${label} scraper] Launch Chromium headless=${headless}`);
    sharedBrowserPromise = playwright.chromium.launch(launchOptions);
    return await sharedBrowserPromise;
  } catch (error) {
    console.log(`[${label} scraper] Chromium launch failed: ${error.message}`);
    const executablePath = findWindowsBrowser();
    if (executablePath) {
      console.log(`[${label} scraper] Fallback local browser: ${executablePath}`);
      sharedBrowserPromise = playwright.chromium.launch({ ...launchOptions, executablePath });
      return sharedBrowserPromise;
    }
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

async function waitNetworkIdle(page, debug) {
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(SEARCH_TIMEOUT, 5000) });
    debug("networkidle reached");
  } catch (error) {
    debug(`networkidle timeout: ${error.message}`);
  }
}

async function waitForAnySelector(page, selectors, timeout, debug) {
  const combined = selectors.join(", ");
  try {
    await page.waitForSelector(combined, { timeout });
    debug(`waitForSelector success: ${combined}`);
  } catch (error) {
    debug(`waitForSelector failed: ${combined} | ${error.message}`);
  }
}

async function scrollForResults(page, limit, debug) {
  for (let i = 0; i < 2; i += 1) {
    const count = await page.locator("img[src]").count().catch(() => 0);
    debug(`Scroll ${i + 1}: image count=${count}`);
    if (count >= limit) break;
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(350);
  }
}

async function selectorCounts(page, selectors) {
  const entries = await Promise.all(Object.entries(selectors).map(async ([name, selector]) => {
    try {
      return [name, await page.locator(selector).count()];
    } catch (error) {
      return [name, `selector error: ${error.message}`];
    }
  }));
  return Object.fromEntries(entries);
}

async function looksBlocked(page) {
  const text = (await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")).toLowerCase();
  return /captcha|verify|verification|login|log in|masuk|sign in|access denied|unusual traffic/.test(text);
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
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  scrapeTikTokSearch,
  scrapeTikTokShopProducts
};
