const { getCategories, getCategoryKeywords } = require("../services/categories");
const { getResultsByKeyword, makeInput } = require("../services/researchJobs");
const { deleteSavedProduct, listSavedProducts, saveProduct } = require("../services/savedProducts");
const { scoreShopeeProducts } = require("../services/scoring");
const { clearCache, getCache, getCacheStatus, setCache } = require("../services/cacheStore");
const { getQuotaStatus, shouldSlowDownRequests } = require("../services/quotaMonitor");
const { getProductPerformance, isShopeeAmsConfigured } = require("../services/shopeeAms");
const {
  buildAuthUrl,
  debugAmsProductPerformance,
  exchangeCodeForToken,
  getAmsProductPerformance,
  getDebugSign,
  getShopInfo,
  getStatus: getShopeeOpenStatus,
  parseCallbackQuery,
  refreshTokenIfAvailable
} = require("../services/shopeeOpen");
const { extractProductKeywords } = require("../services/keywordExtraction");
const { buildOpportunities, fetchYouTubeShortsIndonesia, matchProductsToShorts } = require("../services/shortsResearch");
const { enrichTrendIntelligence, toCsv } = require("../services/trendIntelligence");
const { discoverViralProducts } = require("../services/viralDiscovery");
const { filterQualityShorts } = require("../services/qualityFilter");
const { assertUsageAllowed, getUsageStatus, isDevelopmentUnlimited, recordSearch } = require("../services/usageLimiter");
const { getSearchAnalytics, recordSearchAnalytics } = require("../services/searchAnalytics");
const { scrapeShopeeSearch } = require("../scraper/shopee");

const CACHE_TTL_MS = 30 * 60 * 1000;
const responseCache = new Map();
let lastResearchExport = null;

function createAdvancedApiHandler({ fetchYouTubeTrends, researchJobService }) {
  return async function handleAdvancedApi(url, sendJson, req, sendText, sendRedirect) {
  if (url.pathname === "/api/research" && req.method === "POST") {
    const body = await readJsonBody(req);
    const mode = normalizeMode(body.mode);
    const keyword = cleanKeyword(body.keyword || "");
    const category = cleanKeyword(body.category || "");

    if (mode === "manual" && !keyword) return sendJson({ error: "Keyword wajib diisi untuk mode Manual." }, 400);
    if (mode === "category" && !category) return sendJson({ error: "Kategori wajib dipilih." }, 400);

    const cacheKey = researchCacheKey({ mode, keyword, category });
    try {
      assertUsageAllowed(req);
    } catch (error) {
      return sendJson({ error: error.message, usage: getUsageStatus(req) }, error.status || 429);
    }
    const cachedResult = getCache(cacheKey);
    if (cachedResult) {
      lastResearchExport = cachedResult;
      const usage = recordSearch(req);
      recordSearchAnalytics({ keyword, category, mode, result: cachedResult });
      return sendJson({ ...cachedResult, usage });
    }
    if (shouldSlowDownRequests() && mode === "auto") {
      const expired = getCache(cacheKey, { allowExpired: true });
      if (expired) return sendJson({ ...expired, fromCache: true, quotaSlowdown: true });
    }
    let result;
    try {
      result = await runUnifiedResearch({ mode, keyword, category, fetchYouTubeTrends });
    } catch (error) {
      if (error.code === "YOUTUBE_QUOTA_EXCEEDED") {
        const expired = getCache(cacheKey, { allowExpired: true });
        if (expired) return sendJson({ ...expired, fromCache: true, quotaFallback: true });
      }
      throw error;
    }
    lastResearchExport = result;
    result = setCache(cacheKey, mode === "category" ? category : keyword || "auto", result);
    result.usage = recordSearch(req);
    recordSearchAnalytics({ keyword, category, mode, result });
    return sendJson(result);
  }

  if (url.pathname === "/api/export/json" && req.method === "GET") {
    if (process.env.ENABLE_EXPORT === "false" && !isDevelopmentUnlimited(req)) return sendJson({ error: "Export sedang dinonaktifkan oleh admin." }, 403);
    const data = getExportData(url);
    if (!data) return sendJson({ error: "Belum ada hasil research untuk export." }, 404);
    return sendJson({
      exportedAt: new Date().toISOString(),
      count: getExportItems(data).length,
      data
    });
  }

  if (url.pathname === "/api/export/csv" && req.method === "GET") {
    if (process.env.ENABLE_EXPORT === "false" && !isDevelopmentUnlimited(req)) return sendJson({ error: "Export sedang dinonaktifkan oleh admin." }, 403);
    const data = getExportData(url);
    if (!data) return sendJson({ error: "Belum ada hasil research untuk export." }, 404);
    const csv = toCsv(getExportItems(data));
    if (sendText) return sendText(csv, 200, "text/csv; charset=utf-8");
    return sendJson({ csv });
  }

  if (url.pathname === "/api/trending/discover" && req.method === "GET") {
    if (process.env.ENABLE_DISCOVERY === "false" && !isDevelopmentUnlimited(req)) return sendJson({ error: "Discovery sedang dinonaktifkan oleh admin." }, 403);
    try {
      const data = await discoverViralProducts({
        fetchYouTubeTrends,
        force: url.searchParams.get("refresh") === "1"
      });
      return sendJson(data);
    } catch (error) {
      return sendJson({
        error: error.message || "Trending discovery gagal.",
        code: error.code || undefined
      }, error.code === "YOUTUBE_API_KEY_MISSING" ? 400 : error.code === "YOUTUBE_QUOTA_EXCEEDED" ? 429 : 502);
    }
  }

  if (url.pathname === "/api/usage-status" && req.method === "GET") {
    return sendJson(getUsageStatus(req));
  }

  if (url.pathname === "/api/search-analytics" && req.method === "GET") {
    return sendJson(getSearchAnalytics());
  }

  if (url.pathname === "/api/cache-status" && req.method === "GET") {
    return sendJson(getCacheStatus());
  }

  if (url.pathname === "/api/quota-status" && req.method === "GET") {
    return sendJson(getQuotaStatus());
  }

  if ((url.pathname === "/api/shopee/auth-url" || url.pathname === "/api/shopee/auth") && req.method === "GET") {
    try {
      return sendJson(buildAuthUrl());
    } catch (error) {
      return sendJson({ error: error.message }, error.code === "SHOPEE_OPEN_NOT_CONFIGURED" ? 400 : 500);
    }
  }

  if (url.pathname === "/api/shopee/debug-sign" && req.method === "GET") {
    try {
      return sendJson(getDebugSign());
    } catch (error) {
      return sendJson({ error: error.message }, error.code === "SHOPEE_OPEN_NOT_CONFIGURED" ? 400 : 500);
    }
  }

  if (url.pathname === "/api/shopee/callback-debug" && req.method === "GET") {
    try {
      return sendJson(parseCallbackQuery(url.searchParams));
    } catch (error) {
      return sendJson({ error: error.message }, 500);
    }
  }

  if (url.pathname === "/api/shopee/callback" && req.method === "GET") {
    try {
      const callbackDebug = parseCallbackQuery(url.searchParams);
      if (!callbackDebug.validation.valid) {
        return sendJson({
          error: callbackDebug.validation.message,
          debug: callbackDebug
        }, callbackDebug.validation.code === "SHOPEE_CODE_MISSING" || callbackDebug.validation.code === "SHOPEE_SHOP_ID_MISSING" ? 400 : 422);
      }
      const token = await exchangeCodeForToken({
        code: url.searchParams.get("code") || "",
        shopId: url.searchParams.get("shop_id") || url.searchParams.get("shopid") || ""
      });
      const redirectTarget = "/?shopee=connected&message=Shopee%20connected%20successfully";
      if (sendRedirect) return sendRedirect(redirectTarget, 302);
      return sendJson({
        ok: true,
        message: "Shopee authorization berhasil. Token disimpan ke data/shopee-token.json.",
        shop_id: token.shop_id,
        expires_at: token.expires_at
      });
    } catch (error) {
      return sendJson({
        error: error.message,
        detail: error.response || error.debug || undefined
      }, error.code === "SHOPEE_CODE_MISSING" || error.code === "SHOPEE_SHOP_ID_MISSING" ? 400 : error.code === "SHOPEE_SHOP_ID_INVALID" || error.code === "SHOPEE_CODE_INVALID" ? 422 : error.code === "SHOPEE_OPEN_NOT_CONFIGURED" ? 400 : 502);
    }
  }

  if (url.pathname === "/api/shopee/status" && req.method === "GET") {
    return sendJson(await getShopeeOpenStatus());
  }

  if (url.pathname === "/api/shopee/me" && req.method === "GET") {
    try {
      return sendJson(await getShopInfo());
    } catch (error) {
      return sendJson({
        error: error.message,
        detail: error.response || undefined,
        requestUrl: error.requestUrl || undefined
      }, error.code === "SHOPEE_NOT_AUTHORIZED" || error.code === "SHOPEE_TOKEN_EXPIRED" || error.code === "SHOPEE_OPEN_NOT_CONFIGURED" ? 400 : 502);
    }
  }

  if (url.pathname === "/api/shopee/refresh-token" && req.method === "POST") {
    try {
      const token = await refreshTokenIfAvailable();
      return sendJson({ ok: true, shop_id: token.shop_id, expires_at: token.expires_at });
    } catch (error) {
      return sendJson({ error: error.message, detail: error.response || undefined }, error.code?.startsWith("SHOPEE_") ? 400 : 502);
    }
  }

  if (url.pathname === "/api/cache-clear" && req.method === "POST") {
    clearCache();
    return sendJson({ ok: true, ...getCacheStatus() });
  }

  if (url.pathname === "/api/research-job" && req.method === "POST") {
    const body = await readJsonBody(req);
    const input = makeInput(body);
    if (!input.keyword && !input.category) return sendJson({ error: "Keyword or category is required." }, 400);
    const job = await researchJobService.enqueue(input);
    return sendJson(job, 202);
  }

  if (url.pathname.startsWith("/api/research-job/") && req.method === "GET") {
    const id = decodeURIComponent(url.pathname.replace("/api/research-job/", ""));
    const job = researchJobService.getJob(id);
    if (!job) return sendJson({ error: "Research job not found." }, 404);
    return sendJson(job);
  }

  if (url.pathname === "/api/results" && req.method === "GET") {
    const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
    if (!keyword) return sendJson({ error: "Keyword is required." }, 400);
    const result = getResultsByKeyword(keyword);
    if (!result) return sendJson({ error: "No cached result for keyword." }, 404);
    return sendJson(result);
  }

  if (url.pathname === "/api/saved-products") {
    if (req.method === "GET") {
      return sendJson({ items: await listSavedProducts() });
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const item = await saveProduct(body);
      return sendJson({ item }, 201);
    }

    if (req.method === "DELETE") {
      const id = cleanKeyword(url.searchParams.get("id") || "");
      if (!id) return sendJson({ error: "Saved product id is required." }, 400);
      return sendJson(await deleteSavedProduct(id));
    }

    return sendJson({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === "/api/shorts-trending") {
    const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
    const limit = clamp(Number(url.searchParams.get("limit") || 20), 20, 25);
    const cacheKey = `shorts:${keyword || "auto"}:${limit}`;
    try {
      const data = await cached(cacheKey, async () => {
        const shorts = await fetchYouTubeShortsIndonesia({ keyword, limit, fetchYouTubeTrends, maxKeywords: keyword ? 2 : 1 });
        return { platform: "youtube-shorts-id", keyword, count: shorts.items.length, debug: shorts.debug, items: shorts.items };
      }, 1);
      return sendJson(data);
    } catch (error) {
      return sendJson({
        error: error.message || "YouTube request gagal",
        debug: {
          keyword,
          apiKeyConfigured: Boolean(process.env.YOUTUBE_API_KEY),
          requestUrl: error.requestUrl || "",
          detail: error.response || error.debug || error.cause?.message || error.stack || error.message
        }
      }, error.code === "YOUTUBE_API_KEY_MISSING" ? 400 : error.code === "YOUTUBE_QUOTA_EXCEEDED" ? 429 : 502);
    }
  }

  if (url.pathname === "/api/shopee-performance") {
    const limit = clamp(Number(url.searchParams.get("page_size") || url.searchParams.get("limit") || 20), 1, 100);
    const params = {
      period_type: url.searchParams.get("period_type") || undefined,
      order_type: url.searchParams.get("order_type") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      page_no: url.searchParams.get("page_no") || undefined,
      page_size: limit
    };

    try {
      const cacheKey = `shopee-ams:${JSON.stringify(params)}`;
      const data = await cached(cacheKey, () => getProductPerformance(params), 0);
      return sendJson(data);
    } catch (error) {
      return sendJson({
        error: error.message || "Shopee AMS API belum tersedia.",
        configured: isShopeeAmsConfigured()
      }, error.code === "SHOPEE_AMS_NOT_CONFIGURED" ? 400 : 502);
    }
  }

  if (url.pathname === "/api/shopee/ams-product-performance" && req.method === "GET") {
    const params = {
      period_type: url.searchParams.get("period_type") || undefined,
      order_type: url.searchParams.get("order_type") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      page_no: url.searchParams.get("page_no") || undefined,
      page_size: url.searchParams.get("page_size") || undefined
    };
    try {
      const data = await getAmsProductPerformance(params);
      return sendJson(data);
    } catch (error) {
      return sendJson({
        error: error.message,
        detail: error.response || undefined,
        requestUrl: error.requestUrl || undefined
      }, error.code === "SHOPEE_NOT_AUTHORIZED" || error.code === "SHOPEE_OPEN_NOT_CONFIGURED" ? 400 : 502);
    }
  }

  if (url.pathname === "/api/shopee/debug-trends" && req.method === "GET") {
    const params = {
      period_type: url.searchParams.get("period_type") || undefined,
      order_type: url.searchParams.get("order_type") || undefined,
      channel: url.searchParams.get("channel") || undefined,
      page_no: url.searchParams.get("page_no") || undefined,
      page_size: url.searchParams.get("page_size") || url.searchParams.get("limit") || 20
    };
    const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
    const debug = await debugAmsProductPerformance(params);
    return sendJson({
      keyword,
      ...debug
    });
  }

  if (url.pathname === "/api/shopee/search-products" && req.method === "GET") {
    const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
    const limit = clamp(Number(url.searchParams.get("limit") || 8), 1, 20);
    if (!keyword) return sendJson({ error: "Keyword wajib diisi." }, 400);

    try {
      const items = await scrapeShopeeSearch(keyword, { limit });
      return sendJson({
        keyword,
        count: items.length,
        items
      });
    } catch (error) {
      return sendJson({
        error: error.message,
        debug: error.debug || {}
      }, 502);
    }
  }

  if (url.pathname === "/api/product-research" || url.pathname === "/api/shorts-product-research") {
    const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
    const limit = clamp(Number(url.searchParams.get("limit") || 12), 6, 20);
    const research = await runShortsProductResearch(keyword, limit, fetchYouTubeTrends);

    return sendJson({
      keyword,
      youtube: research.youtube,
      shopee: research.shopee,
      opportunities: research.opportunities,
      keywords: research.keywords,
      debug: research.debug,
      errors: research.errors
    });
  }

  if (url.pathname === "/api/full-research") {
    const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
    const limit = clamp(Number(url.searchParams.get("limit") || 20), 10, 25);
    if (!keyword) return sendJson({ error: "Keyword is required." }, 400);

    const keywords = [keyword];
    const runs = await Promise.allSettled(keywords.map((item) => researchKeyword(item, Math.min(limit, 6), fetchYouTubeTrends)));
    const fulfilled = runs.filter((run) => run.status === "fulfilled").map((run) => run.value);

    const youtubeRaw = fulfilled.flatMap((result) => result.youtube);
    const shopeeRaw = fulfilled.flatMap((result) => result.shopee);
    const youtubeItems = dedupeBy(youtubeRaw, (item) => item.url || item.id || item.title).sort((a, b) => b.score - a.score).slice(0, 30);
    const shopeeItems = scoreShopeeProducts(dedupeBy(shopeeRaw, (item) => item.item_id || item.url || item.name), keywords.join(" ")).slice(0, 5);
    const opportunities = buildOpportunities(youtubeItems, shopeeItems);
    const sourceErrors = fulfilled.flatMap((result) => result.errors);
    const runErrors = runs.map((run, index) => run.status === "rejected" ? `${keywords[index]}: ${run.reason.message}` : "").filter(Boolean);
    logDebugErrors("full-research", sourceErrors.concat(runErrors));

    return sendJson({
      keyword,
      keywords,
      youtube: youtubeItems,
      shopee: shopeeItems,
      opportunities,
      errors: {
        youtube: sourceErrors.some((error) => error.includes("YouTube")) ? "YouTube belum tersedia" : "",
      shopee: sourceErrors.some((error) => error.includes("Shopee")) ? "Shopee AMS API belum dikonfigurasi." : "",
        other: runErrors.length ? "Sebagian keyword gagal diproses" : ""
      }
    });
  }

  if (url.pathname === "/api/categories") {
    return sendJson({
      categories: getCategories()
    });
  }

  if (url.pathname === "/api/category-research") {
    const category = cleanKeyword(url.searchParams.get("category") || "");
    const resolvedCategory = resolveCategory(category);
    const keywords = getCategoryKeywords(resolvedCategory);
    if (!category) return sendJson({ error: "Category is required." }, 400);
    if (!keywords.length) {
      return sendJson({
        error: `Category "${category}" not found. Use one of: ${getCategories().join(", ")}`
      }, 404);
    }

    const selectedKeywords = keywords.slice(0, clamp(Number(url.searchParams.get("keywords") || 2), 1, 2));
    const perKeywordLimit = clamp(Number(url.searchParams.get("limit") || 6), 5, 8);
    const runs = await Promise.allSettled(selectedKeywords.map((keyword) => researchKeyword(keyword, perKeywordLimit, fetchYouTubeTrends)));
    const fulfilled = runs.filter((run) => run.status === "fulfilled").map((run) => run.value);

    const youtubeRaw = fulfilled.flatMap((result) => result.youtube);
    const shopeeRaw = fulfilled.flatMap((result) => result.shopee);
    const sourceErrors = fulfilled.flatMap((result) => result.errors);
    const runErrors = runs.map((run, index) => run.status === "rejected" ? `${selectedKeywords[index]}: ${run.reason.message}` : "").filter(Boolean);
    logDebugErrors("category-research", sourceErrors.concat(runErrors));
    const youtube = dedupeBy(youtubeRaw, (item) => item.url || item.id || item.title).sort((a, b) => b.score - a.score).slice(0, 30);
    const shopee = scoreShopeeProducts(dedupeBy(shopeeRaw, (item) => item.item_id || item.url || item.name), selectedKeywords.join(" ")).slice(0, 5);
    const opportunities = buildOpportunities(youtube, shopee);

    return sendJson({
      category: resolvedCategory,
      keywords: selectedKeywords,
      youtube,
      shopee,
      opportunities,
      errors: simpleSourceErrors(sourceErrors, runErrors)
    });
  }

  return false;
  };
}

function simpleSourceErrors(sourceErrors, runErrors = []) {
  return [
    sourceErrors.some((error) => error.includes("YouTube")) ? "YouTube belum tersedia" : "",
    sourceErrors.some((error) => error.includes("Shopee")) ? "Shopee AMS API belum dikonfigurasi." : "",
    runErrors.length ? "Sebagian keyword gagal diproses" : ""
  ].filter(Boolean);
}

function logDebugErrors(scope, errors) {
  if (!errors.length) return;
  console.warn(`[${scope}] debug errors: ${errors.join(" | ")}`);
}

function resolveCategory(category) {
  const normalized = category.toLowerCase();
  return getCategories().find((item) => item.toLowerCase() === normalized) || category;
}

async function researchKeyword(keyword, limit, fetchYouTubeTrends) {
  const youtubeResult = await Promise.resolve()
    .then(() => withTimeout(fetchYouTubeShortsIndonesia({ keyword, limit: 20, fetchYouTubeTrends, maxKeywords: 2 }), 15000, "YouTube Shorts belum tersedia"))
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
  const shorts = youtubeResult.status === "fulfilled" ? youtubeResult.value.items || [] : [];
  const productKeywords = dedupeBy(shorts.flatMap((item) => extractProductKeywords(item.title)).concat(keyword), (item) => item).slice(0, 4);
  const shopeeResult = await Promise.resolve()
    .then(() => fetchAffiliateProducts(productKeywords.join(" "), limit))
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
  const shopeeItems = shopeeResult.status === "fulfilled" ? shopeeResult.value : [];

  return {
    keyword,
    youtube: shorts,
    shopee: shopeeItems,
    errors: [
      youtubeResult.status === "rejected" ? `${keyword} YouTube: ${youtubeResult.reason.message}` : youtubeResult.value?.message ? `${keyword} YouTube: ${youtubeResult.value.message}` : "",
      shopeeResult.status === "rejected" ? `${keyword} Shopee: ${shopeeResult.reason.message}` : ""
    ].filter(Boolean)
  };
}

async function runShortsProductResearch(keyword, limit, fetchYouTubeTrends) {
  const youtubeResult = await Promise.resolve()
    .then(() => withTimeout(fetchYouTubeShortsIndonesia({ keyword, limit, fetchYouTubeTrends, maxKeywords: 2 }), 10000, "YouTube Shorts belum tersedia"))
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
  const youtube = youtubeResult.status === "fulfilled" ? youtubeResult.value.items || [] : [];
  const keywords = dedupeBy(youtube.flatMap((item) => item.extractedKeywords || extractProductKeywords(item.title)).concat(keyword || []), (item) => item).slice(0, 5);
  const shopeeResult = await Promise.resolve()
    .then(() => fetchAffiliateProducts(keywords.join(" "), limit))
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
  const shopee = matchProductsToShorts(youtube, shopeeResult.status === "fulfilled" ? shopeeResult.value : []).slice(0, 5);
  return {
    youtube,
    shopee,
    opportunities: buildOpportunities(youtube, shopee),
    keywords,
    debug: youtubeResult.status === "fulfilled" ? youtubeResult.value.debug : undefined,
    errors: {
      youtube: youtubeResult.status === "rejected" ? "YouTube Shorts belum tersedia" : "",
      shopee: shopeeResult.status === "rejected" ? shopeeResult.reason.message : ""
    }
  };
}

async function runUnifiedResearch({ mode, keyword, category, fetchYouTubeTrends }) {
  const baseKeywords = resolveResearchKeywords({ mode, keyword, category });
  const targetShorts = mode === "auto" ? 20 : 10;
  const shortsLimit = 25;
  const queries = mode === "auto" ? [""] : mode === "category" ? baseKeywords.slice(0, 2) : [keyword];

  const shortsRuns = await Promise.allSettled(queries.map((query) => (
    withRetry(() => withTimeout(fetchYouTubeShortsIndonesia({
      keyword: query,
      limit: shortsLimit,
      fetchYouTubeTrends,
      maxKeywords: mode === "auto" ? 1 : mode === "category" ? 1 : 2
    }), 12000, "YouTube Shorts belum tersedia"), 1)
  )));
  let shorts = filterQualityShorts(dedupeBy(
    shortsRuns.flatMap((run) => run.status === "fulfilled" ? run.value.items || [] : []),
    (item) => item.url || item.id || item.title
  )).sort((a, b) => b.product_confidence - a.product_confidence || b.engagementRate - a.engagementRate || b.views - a.views).slice(0, mode === "auto" ? 25 : 20);
  const youtubeDebug = shortsRuns.map((run) => run.status === "fulfilled" ? run.value.debug : { error: run.reason?.message || "YouTube request failed" });
  const intelligence = enrichTrendIntelligence(shorts, baseKeywords);
  shorts = intelligence.items
    .sort((a, b) => b.product_confidence - a.product_confidence || b.engagementRate - a.engagementRate || b.views - a.views)
    .slice(0, mode === "auto" ? 25 : 20);
  const keywordRecommendations = intelligence.keywordRecommendations.concat(shortsRuns.flatMap((run) => run.status === "fulfilled" ? run.value.keywordRecommendations || [] : []))
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, 8);
  const topKeywordTurunan = shortsRuns.flatMap((run) => run.status === "fulfilled" ? run.value.topKeywordTurunan || [] : [])
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, 8);
  const topProductAngles = intelligence.topProductAngles.concat(shortsRuns.flatMap((run) => run.status === "fulfilled" ? run.value.topProductAngles || [] : []))
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, 8);
  const stats = {
    ...buildAggregateStats(shorts, keywordRecommendations, shortsRuns),
    ...intelligence.analyticsSummary
  };

  const extractedKeywords = dedupeBy(
    shorts.flatMap((item) => item.extractedKeywords || extractProductKeywords(item.title)).concat(baseKeywords),
    (item) => item
  ).slice(0, 8);

  const productQueries = dedupeBy((extractedKeywords.length ? extractedKeywords : []).concat(baseKeywords), (item) => item).slice(0, 10);
  const shopeeRuns = [await Promise.resolve()
    .then(() => fetchAffiliateProducts(productQueries.join(" "), 20))
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }))];
  const rawProducts = shopeeRuns.flatMap((run) => run.status === "fulfilled" ? run.value : []);
  const scoredProducts = scoreShopeeProducts(dedupeBy(rawProducts, (item) => item.item_id || item.url || item.name), productQueries.join(" ")).slice(0, 5);
  let shopeeSearchError = "";
  let shopeeSearchDebug = null;
  const scrapedProducts = scoredProducts.length ? [] : await fetchShopeeSearchFallbackProducts(productQueries).catch((error) => {
    shopeeSearchError = error.message;
    shopeeSearchDebug = error.debug || null;
    console.warn(`[shopee-search-fallback] ${error.message}`);
    return [];
  });
  const fallbackProducts = scoredProducts.length || scrapedProducts.length ? [] : buildShopeeKeywordFallbackProducts({
    productQueries,
    shorts,
    mode,
    keyword,
    category
  });
  const shopeeProducts = scoredProducts.length ? scoredProducts : scrapedProducts.length ? scrapedProducts : fallbackProducts;
  const products = matchProductsToShorts(
    shorts,
    shopeeProducts
  ).slice(0, scoredProducts.length ? 5 : 8);
  const opportunities = buildOpportunities(shorts, products);

  return {
    mode,
    keyword: mode === "manual" ? keyword : "",
    category: mode === "category" ? category : "",
    shorts,
    products,
    opportunities,
    keywordRecommendations,
    topKeywordTurunan,
    topProductAngles,
    trendClusters: intelligence.trendClusters,
    analyticsSummary: intelligence.analyticsSummary,
    stats,
    debug: {
      youtube: youtubeDebug,
      shopee: {
        usedAms: Boolean(scoredProducts.length),
        usedShopeeSearch: Boolean(scrapedProducts.length),
        usedManualFallback: Boolean(fallbackProducts.length),
        searchFallbackError: shopeeSearchError,
        searchFallbackDebug: shopeeSearchDebug ? sanitizeShopeeDebug(shopeeSearchDebug) : null
      }
    },
    message: buildResearchMessage({ mode, shorts, products, opportunities, shortsRuns, shopeeRuns, usedShopeeFallback: !scoredProducts.length && fallbackProducts.length, usedShopeeScraper: !scoredProducts.length && scrapedProducts.length, shopeeSearchError })
  };
}

function buildAggregateStats(shorts, keywordRecommendations, shortsRuns) {
  const sourceStats = shortsRuns
    .filter((run) => run.status === "fulfilled" && run.value.stats)
    .map((run) => run.value.stats);
  const totalViews = shorts.reduce((sum, item) => sum + Number(item.views || 0), 0);
  const totalEngagement = shorts.reduce((sum, item) => sum + Number(item.engagementRate || 0), 0);
  return {
    averageViews: shorts.length ? Math.round(totalViews / shorts.length) : Math.round(sourceStats[0]?.averageViews || 0),
    averageEngagement: shorts.length ? totalEngagement / shorts.length : Number(sourceStats[0]?.averageEngagement || 0),
    topKeyword: keywordRecommendations[0] || sourceStats[0]?.topKeyword || ""
  };
}

function getExportData(url) {
  const mode = normalizeMode(url.searchParams.get("mode") || "manual");
  const keyword = cleanKeyword(url.searchParams.get("keyword") || "");
  const category = cleanKeyword(url.searchParams.get("category") || "");
  if (keyword || category || mode === "auto") {
    const cachedResult = getCache(researchCacheKey({ mode, keyword, category }), { allowExpired: true });
    if (cachedResult) return cachedResult;
  }
  return lastResearchExport;
}

function getExportItems(data) {
  const shorts = Array.isArray(data?.shorts) ? data.shorts : [];
  const opportunities = Array.isArray(data?.opportunities) ? data.opportunities : [];
  if (shorts.length) return shorts;
  return opportunities.map((item) => item.short || item);
}

function resolveResearchKeywords({ mode, keyword, category }) {
  if (mode === "auto") return [];
  if (mode === "manual") return dedupeBy([keyword], (item) => item);
  const resolvedCategory = resolveCategory(category);
  const categoryKeywords = getCategoryKeywords(resolvedCategory).slice(0, 2);
  return categoryKeywords.length ? categoryKeywords : [category].filter(Boolean);
}

function buildResearchMessage({ mode, shorts, products, opportunities, shortsRuns, shopeeRuns, usedShopeeFallback = false, usedShopeeScraper = false, shopeeSearchError = "" }) {
  const parts = [
    `${shorts.length} video viral`,
    `${products.length} produk Affiliate`,
    `${opportunities.length} peluang`
  ];
  const warnings = [];
  if (!shorts.length || shortsRuns.some((run) => run.status === "rejected")) warnings.push("YouTube Shorts sebagian gagal");
  if (usedShopeeFallback) warnings.push(shopeeSearchError
    ? `Shopee belum bisa mengambil produk langsung (${summarizeShopeeSearchFailure(shopeeSearchError)})`
    : "Shopee memakai rekomendasi keyword manual sambil menunggu data AMS");
  if (usedShopeeScraper) warnings.push("Shopee memakai hasil produk real dari pencarian");
  const shopeeErrors = shopeeRuns
    .filter((run) => run.status === "rejected")
    .map((run) => run.reason?.message || "");
  const shopeeEmptyReasons = shopeeRuns
    .filter((run) => run.status === "fulfilled" && run.value?.debugReason)
    .map((run) => run.value.debugReason);
  if (!products.length || shopeeErrors.length) {
    warnings.push(shopeeErrors.some((message) => message.includes("Shopee AMS API belum dikonfigurasi"))
      ? "Shopee AMS API belum dikonfigurasi"
      : shopeeEmptyReasons[0] || normalizeShopeeTrendReason(shopeeErrors[0]) || "Produk Affiliate belum tersedia");
  }
  const prefix = mode === "auto" ? "Auto Discover selesai" : mode === "category" ? "Riset kategori selesai" : "Riset manual selesai";
  return warnings.length ? `${prefix}: ${parts.join(", ")}. Catatan: ${warnings.join(", ")}.` : `${prefix}: ${parts.join(", ")}.`;
}

function summarizeShopeeSearchFailure(message = "") {
  const text = String(message || "");
  if (/EPERM|spawn/i.test(text)) return "browser Playwright tidak bisa dibuka dari proses server";
  if (/timeout/i.test(text)) return "timeout saat membuka Shopee";
  if (/403|captcha|login|masuk/i.test(text)) return "Shopee membatasi akses atau butuh login";
  if (/fetch failed|network/i.test(text)) return "request Shopee gagal";
  return "lihat /api/shopee/search-products untuk debug";
}

function sanitizeShopeeDebug(debug = {}) {
  return {
    method1Status: debug.method1Status || "",
    method1Error: debug.method1Error || "",
    method1RawCount: debug.method1RawCount || 0,
    method2Error: debug.method2Error || "",
    method3Error: debug.method3Error || "",
    lastUrl: debug.lastUrl || "",
    anchorCount: debug.anchorCount || 0,
    screenshotPath: debug.screenshotPath || "",
    cookieCount: debug.cookieCount || 0,
    hasCookies: Boolean(debug.hasCookies)
  };
}

async function fetchAffiliateProducts(keyword, limit = 20) {
  const result = await withTimeout(
    getAmsProductPerformance({ page_size: Math.max(20, limit) }),
    15000,
    "Shopee AMS API belum tersedia."
  );
  const items = scoreShopeeProducts(result.items || [], keyword).slice(0, 5);
  items.debugReason = !items.length ? result.message || result.debugReason || "Belum ada data affiliate performance" : "";
  return items;
}

async function fetchShopeeSearchFallbackProducts(productQueries = []) {
  const queries = productQueries.filter(Boolean).slice(0, 2);
  if (!queries.length) return [];
  const results = await Promise.allSettled(queries.map((query) => (
    withTimeout(scrapeShopeeSearch(query, { limit: 8 }), Number(process.env.SHOPEE_SEARCH_FALLBACK_TIMEOUT_MS || 18000), "Shopee search fallback timeout")
  )));
  const raw = results.flatMap((run) => run.status === "fulfilled" ? run.value : []);
  return scoreShopeeProducts(dedupeBy(raw.map(normalizeScrapedShopeeProduct), (item) => item.url || item.name), queries.join(" "))
    .slice(0, 8);
}

function normalizeScrapedShopeeProduct(item) {
  const soldCount = Number(item.soldCount || 0);
  const rating = Number(item.rating || 0);
  const reviewCount = Number(item.reviewCount || 0);
  const score = Math.max(55, Math.min(92, Math.round(
    normalizeCountScore(soldCount) * 38
    + Math.min(1, rating / 5) * 22
    + normalizeCountScore(reviewCount) * 16
    + (item.price ? 10 : 0)
    + (item.image ? 6 : 0)
  )));
  return {
    ...item,
    item_id: item.url || item.name,
    sales: 0,
    items_sold: soldCount,
    soldCount,
    rating,
    reviewCount,
    orders: 0,
    clicks: 0,
    roi: 0,
    new_buyers: 0,
    score,
    chance: score,
    label: score >= 80 ? "HOT" : score >= 60 ? "GOOD" : "LOW",
    validationStatus: "shopee-search-product",
    reason: "Produk real dari hasil pencarian Shopee. Link membuka halaman produk langsung."
  };
}

function normalizeCountScore(value) {
  return Math.min(1, Math.log10(Math.max(Number(value || 0), 1)) / 5);
}

function buildShopeeKeywordFallbackProducts({ productQueries, shorts, mode, keyword, category }) {
  const sourceKeywords = dedupeBy(
    (productQueries || [])
      .concat(mode === "manual" ? [keyword] : [])
      .concat(mode === "category" ? [category] : [])
      .concat((shorts || []).flatMap((item) => item.extractedKeywords || extractProductKeywords(item.title))),
    (item) => item
  )
    .map(cleanKeyword)
    .filter(Boolean)
    .slice(0, 10);

  return sourceKeywords.map((name, index) => {
    const score = Math.max(52, 86 - index * 4);
    return {
      item_id: `manual-shopee-${index + 1}-${name.replace(/\W+/g, "-")}`,
      name: titleCase(name),
      item_name: titleCase(name),
      image: "",
      url: `https://shopee.co.id/search?keyword=${encodeURIComponent(name)}`,
      sales: 0,
      est_commission: 0,
      items_sold: 0,
      soldCount: 0,
      orders: 0,
      clicks: 0,
      roi: 0,
      new_buyers: 0,
      score,
      chance: score,
      label: score >= 80 ? "HOT" : score >= 60 ? "GOOD" : "LOW",
      keyword: name,
      parent_keyword: name,
      validationStatus: "manual-keyword",
      reason: "Rekomendasi Shopee berdasarkan keyword dan video YT. Klik Cari di Shopee untuk validasi produk."
    };
  });
}

function titleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeShopeeTrendReason(message = "") {
  const text = String(message || "");
  if (/permission|forbidden|no auth|unauthorized|access/i.test(text)) return "Permission AMS belum aktif";
  if (/ams|affiliate/i.test(text)) return "AMS belum tersedia untuk toko ini";
  if (/not authorized|belum authorized|token/i.test(text)) return "Shopee belum authorized";
  return "";
}

function normalizeMode(mode) {
  if (mode === "keyword") return "manual";
  if (mode === "category") return "category";
  return mode === "manual" ? "manual" : "auto";
}

function researchCacheKey({ mode, keyword, category }) {
  return `research:v4-shopee-products:${mode}:${String(mode === "category" ? category : keyword || "auto").toLowerCase()}`;
}

function dedupeBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(getKey(item) || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanKeyword(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 120);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

async function cached(key, producer, minItems = 0) {
  const existing = responseCache.get(key);
  const itemCount = existing?.data?.items?.length || existing?.data?.shorts?.length || 0;
  if (existing && Date.now() - existing.createdAt < CACHE_TTL_MS && itemCount >= minItems) {
    return { ...existing.data, cached: true };
  }

  const data = await producer();
  responseCache.set(key, { createdAt: Date.now(), data });
  return data;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  let settled = false;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      if (settled) return;
      const error = new Error(message);
      error.debug = {
        method1Status: "",
        method1Error: message,
        method1RawCount: 0,
        method2Error: "Timeout sebelum network capture selesai.",
        method3Error: "Timeout sebelum DOM fallback selesai.",
        lastUrl: "",
        sampleHtmlText: "",
        screenshotPath: ""
      };
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    settled = true;
    clearTimeout(timeout);
  });
}

async function withRetry(fn, retries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error.code === "YOUTUBE_QUOTA_EXCEEDED" || error.code === "YOUTUBE_API_KEY_MISSING") break;
      if (attempt < retries) await wait(350 * (attempt + 1));
    }
  }
  throw lastError;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  createAdvancedApiHandler
};
