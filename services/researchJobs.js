const { Queue, Worker, QueueEvents } = optionalBullMQ();
const { getCategoryKeywords } = require("./categories");
const { expandKeyword } = require("./keywordExpansion");
const { scoreShopeeProducts } = require("./scoring");
const { getProductPerformance } = require("./shopeeAms");
const { extractProductKeywords } = require("./keywordExtraction");
const { buildOpportunities, fetchYouTubeShortsIndonesia, matchProductsToShorts } = require("./shortsResearch");

const CACHE_TTL_MS = Number(process.env.RESULT_CACHE_TTL_MS || 10 * 60 * 1000);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 30 * 60 * 1000);
const REDIS_URL = process.env.REDIS_URL || "";
const JOBS = new Map();
const RESULTS = new Map();

let queueService;

function createResearchJobService({ fetchYouTubeTrends }) {
  if (queueService) return queueService;

  const processor = (job) => processResearchJob(job, fetchYouTubeTrends);
  const memory = createMemoryQueue(processor, { silent: Boolean(Queue && Worker && REDIS_URL) });
  const bull = createBullQueue(processor, memory);
  queueService = bull || memory;
  return queueService;
}

function createBullQueue(processor, fallbackQueue) {
  if (!Queue || !Worker) {
    warnOnce("missing-bullmq", "[research queue] BullMQ belum terinstall. Menggunakan in-memory queue.");
    return null;
  }

  if (!REDIS_URL) {
    warnOnce("missing-redis-url", "[research queue] REDIS_URL kosong. Menggunakan in-memory queue.");
    return null;
  }

  try {
    const connection = {
      url: REDIS_URL,
      maxRetriesPerRequest: null,
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 1500),
      enableOfflineQueue: false,
      retryStrategy: (attempt) => (attempt > 1 ? null : 250)
    };
    const queue = new Queue("research", { connection });
    const queueEvents = QueueEvents ? new QueueEvents("research", { connection }) : null;
    const worker = new Worker("research", async (job) => processor(job), {
      connection,
      concurrency: Number(process.env.RESEARCH_CONCURRENCY || 2),
      limiter: {
        max: Number(process.env.RESEARCH_RATE_LIMIT || 8),
        duration: 60_000
      },
      attempts: 2
    });

    attachQueueWarnings(queue, worker, queueEvents);
    console.log("[research queue] BullMQ enabled");

    return {
      mode: "bullmq",
      async enqueue(input) {
        const cached = getCached(input.cacheKey);
        if (cached) return cachedJob(input, cached);

        try {
          const job = await queue.add("research", input, {
            attempts: 2,
            backoff: { type: "fixed", delay: 1000 },
            removeOnComplete: 200,
            removeOnFail: 200
          });
          const state = initialState(job.id, input);
          JOBS.set(String(job.id), state);
          return state;
        } catch (error) {
          warnOnce("bullmq-enqueue-failed", `[research queue] Redis tidak tersedia (${error.message}). Fallback ke in-memory queue.`);
          return fallbackQueue.enqueue(input);
        }
      },
      getJob
    };
  } catch (error) {
    warnOnce("bullmq-init-failed", `[research queue] BullMQ gagal aktif (${error.message}). Menggunakan in-memory queue.`);
    return null;
  }
}

function createMemoryQueue(processor, options = {}) {
  const queue = [];
  let running = 0;
  const concurrency = Number(process.env.RESEARCH_CONCURRENCY || 2);

  if (!options.silent) {
    console.warn("[research queue] In-memory queue enabled. Job hanya tersimpan selama proses server hidup.");
  }

  function pump() {
    while (running < concurrency && queue.length) {
      const entry = queue.shift();
      running += 1;
      runMemoryJob(entry).finally(() => {
        running -= 1;
        pump();
      });
    }
  }

  async function runMemoryJob(entry) {
    const state = JOBS.get(entry.id);
    if (!state) return;
    try {
      updateJob(entry.id, { status: "running", stage: "Mengambil Video Viral Indonesia" });
      const result = await processor({ id: entry.id, data: entry.input });
      updateJob(entry.id, { ...result, status: "completed", stage: "Selesai", completedAt: new Date().toISOString() });
      setCached(entry.input.cacheKey, getJob(entry.id));
    } catch (error) {
      updateJob(entry.id, { status: "failed", stage: "Gagal", error: error.message });
    }
  }

  return {
    mode: "memory",
    async enqueue(input) {
      const cached = getCached(input.cacheKey);
      if (cached) return cachedJob(input, cached);

      const id = createId();
      const state = initialState(id, input);
      JOBS.set(id, state);
      queue.push({ id, input });
      pump();
      return state;
    },
    getJob
  };
}

async function processResearchJob(job, fetchYouTubeTrends) {
  const jobId = String(job.id || job.data?.id || "");
  const input = job.data || job;
  const keyword = input.keyword || "";
  const keywords = resolveKeywords(input);
  const mainKeyword = input.mode === "auto" ? "" : (keywords[0] || keyword);
  const limit = Number(input.limit || 6);

  updateJob(jobId, { stage: "Mengambil Video Viral Indonesia", keywords });

  const youtubePromise = sourceTask("youtube", jobId, async () => {
    const data = await withTimeout(fetchYouTubeShortsIndonesia({
      keyword: mainKeyword,
      days: 30,
      limit: 20,
      fetchYouTubeTrends,
      maxKeywords: input.mode === "auto" ? 1 : 2
    }), 10000, "YouTube Shorts belum tersedia");
    return dedupeBy(data.items || [], (item) => item.url || item.id || item.title).slice(0, 20);
  });

  const youtubeItems = await youtubePromise.catch(() => []);
  const productKeywords = resolveProductKeywords(youtubeItems, keywords, mainKeyword);
  updateJob(jobId, { keywords: productKeywords });

  const shopeePromise = sourceTask("shopee", jobId, async () => {
    const performance = await withTimeout(getProductPerformance({ page_size: Math.min(10, Math.max(1, limit)) }), Number(process.env.SHOPEE_JOB_TIMEOUT_MS || 15000), "Shopee AMS API belum tersedia");
    const matched = matchProductsToShorts(
      youtubeItems,
      scoreShopeeProducts(dedupeBy(performance.items || [], (item) => item.item_id || item.url || item.name), productKeywords.join(" ")).slice(0, 5)
    );
    return matched.slice(0, 5);
  });

  const shopeeItems = await shopeePromise.catch(() => []);
  const opportunities = buildOpportunities(youtubeItems, shopeeItems);
  updateJob(jobId, { results: { opportunities }, sources: { opportunities: "completed" } });

  await Promise.allSettled([youtubePromise, shopeePromise]);
  const state = getJob(jobId);
  const result = {
    keyword,
    category: input.category || "",
    keywords: productKeywords,
    results: state.results,
    errors: state.errors
  };
  setCached(input.cacheKey, { ...state, ...result });
  return result;
}

async function sourceTask(source, jobId, task) {
  updateJob(jobId, { stage: sourceStage(source), sources: { [source]: "running" } });
  try {
    const items = await task();
    updateJob(jobId, { results: { [source]: items }, sources: { [source]: "completed" } });
    return items;
  } catch (error) {
    console.warn(`[research job ${jobId}] ${source} failed: ${error.message}`);
    updateJob(jobId, { errors: { [source]: simpleSourceError(source) }, sources: { [source]: "failed" } });
    return [];
  }
}

function resolveKeywords(input) {
  if (input.category) {
    const categoryKeywords = getCategoryKeywords(input.category);
    return categoryKeywords.length ? categoryKeywords.slice(0, 2) : [input.keyword].filter(Boolean);
  }
  if (input.mode === "auto") return [];
  return expandKeyword(input.keyword, 2).slice(0, 2);
}

function resolveProductKeywords(shorts, fallbackKeywords, mainKeyword) {
  const extracted = shorts.flatMap((item) => extractProductKeywords(item.title || ""));
  const merged = dedupeBy(extracted.concat(fallbackKeywords || [], mainKeyword || []), (item) => item);
  return merged.filter(Boolean).slice(0, 6);
}

function initialState(id, input) {
  return {
    id: String(id),
    status: "queued",
    stage: "Menunggu antrean",
    keyword: input.keyword || "",
    category: input.category || "",
    keywords: resolveKeywords(input),
    sources: { youtube: "queued", shopee: "queued", opportunities: "queued" },
    results: { youtube: [], shopee: [], opportunities: [] },
    errors: {},
    createdAt: new Date().toISOString()
  };
}

function updateJob(id, patch) {
  if (!id) return;
  const current = JOBS.get(String(id));
  if (!current) return;
  JOBS.set(String(id), mergeState(current, patch));
}

function getJob(id) {
  const job = JOBS.get(String(id));
  if (!job) return null;
  if (Date.now() - new Date(job.createdAt).getTime() > JOB_TTL_MS) {
    JOBS.delete(String(id));
    return null;
  }
  return job;
}

function mergeState(current, patch) {
  return {
    ...current,
    ...patch,
    sources: { ...current.sources, ...(patch.sources || {}) },
    results: { ...current.results, ...(patch.results || {}) },
    errors: { ...current.errors, ...(patch.errors || {}) }
  };
}

function makeInput({ keyword, category, mode }) {
  const cleanKeyword = cleanText(keyword || category || "");
  const isAuto = mode === "auto";
  return {
    keyword: isAuto ? "" : cleanKeyword,
    category: category || "",
    mode: mode || (category ? "category" : "keyword"),
    limit: 6,
    cacheKey: `${isAuto ? "auto" : category ? "category" : "keyword"}:${(category || cleanKeyword || "indonesia").toLowerCase()}`
  };
}

function getResultsByKeyword(keyword) {
  const key = `keyword:${cleanText(keyword).toLowerCase()}`;
  const cached = getCached(key);
  return cached || null;
}

function cachedJob(input, cached) {
  const id = createId();
  const state = {
    ...initialState(id, input),
    status: "completed",
    stage: "Selesai",
    results: cached.results || cached.data?.results || { youtube: [], shopee: [], opportunities: [] },
    errors: cached.errors || {},
    cached: true,
    completedAt: new Date().toISOString()
  };
  JOBS.set(id, state);
  return state;
}

function getCached(key) {
  const existing = RESULTS.get(key);
  if (!existing || Date.now() - existing.createdAt > CACHE_TTL_MS) return null;
  return existing.data;
}

function setCached(key, data) {
  if (!key) return;
  RESULTS.set(key, { createdAt: Date.now(), data });
}

function sourceStage(source) {
  if (source === "youtube") return "Mengambil Video Viral Indonesia";
  if (source === "opportunities") return "Menghitung Peluang Viral";
  return "Mengambil Produk Affiliate";
}

function simpleSourceError(source) {
  if (source === "shopee") return "Shopee AMS API belum dikonfigurasi.";
  return "YouTube Shorts belum tersedia";
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

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function optionalBullMQ() {
  try {
    return require("bullmq");
  } catch {
    return {};
  }
}

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const WARNED = new Set();

function warnOnce(key, message) {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(message);
}

function attachQueueWarnings(queue, worker, queueEvents) {
  queue.on("error", (error) => {
    warnOnce("bullmq-queue-error", `[research queue] Redis queue warning: ${error.message}. Request baru akan fallback jika enqueue gagal.`);
  });
  worker.on("error", (error) => {
    warnOnce("bullmq-worker-error", `[research queue] Redis worker warning: ${error.message}. Server tetap berjalan.`);
  });
  if (queueEvents) {
    queueEvents.on("error", (error) => {
      warnOnce("bullmq-events-error", `[research queue] Redis event warning: ${error.message}. Server tetap berjalan.`);
    });
  }
}

module.exports = {
  createResearchJobService,
  getResultsByKeyword,
  makeInput
};
