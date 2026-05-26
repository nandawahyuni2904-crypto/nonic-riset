const els = {
  status: document.querySelector("#status"),
  youtubeBadge: document.querySelector("#youtubeBadge"),
  shopeeBadge: document.querySelector("#shopeeBadge"),
  youtubeKpiStatus: document.querySelector("#youtubeKpiStatus"),
  shopeeKpiStatus: document.querySelector("#shopeeKpiStatus"),
  devBadge: document.querySelector("#devBadge"),
  menuToggle: document.querySelector("#menuToggle"),
  appSidebar: document.querySelector("#appSidebar"),
  themeToggle: document.querySelector("#themeToggle"),
  recentSearchChips: document.querySelector("#recentSearchChips"),
  niche: document.querySelector("#niche"),
  platform: document.querySelector("#platform"),
  days: document.querySelector("#days"),
  search: document.querySelector("#search"),
  summary: document.querySelector("#summary"),
  results: document.querySelector("#results"),
  csv: document.querySelector("#csv"),
  parse: document.querySelector("#parse")
  ,
  productKeyword: document.querySelector("#productKeyword"),
  categoryField: document.querySelector("#categoryField"),
  categorySelect: document.querySelector("#categorySelect"),
  searchModes: document.querySelectorAll("input[name='searchMode']"),
  productSearch: document.querySelector("#productSearch"),
  researchStatus: document.querySelector("#researchStatus"),
  onboardingPanel: document.querySelector("#onboardingPanel"),
  tiktokRows: document.querySelector("#tiktokRows"),
  youtubeRows: document.querySelector("#youtubeRows"),
  shopeeRows: document.querySelector("#shopeeRows"),
  tiktokCount: document.querySelector("#tiktokCount"),
  youtubeCount: document.querySelector("#youtubeCount"),
  shopeeCount: document.querySelector("#shopeeCount"),
  tiktokTotal: document.querySelector("#tiktokTotal"),
  youtubeTotal: document.querySelector("#youtubeTotal"),
  shopeeTotal: document.querySelector("#shopeeTotal"),
  avgViews: document.querySelector("#avgViews"),
  avgEngagement: document.querySelector("#avgEngagement"),
  topKeyword: document.querySelector("#topKeyword"),
  copyKeywords: document.querySelector("#copyKeywords"),
  copyExport: document.querySelector("#copyExport"),
  exportCsv: document.querySelector("#exportCsv"),
  exportJson: document.querySelector("#exportJson"),
  keywordCount: document.querySelector("#keywordCount"),
  keywordRecommendations: document.querySelector("#keywordRecommendations"),
  derivedKeywordCount: document.querySelector("#derivedKeywordCount"),
  derivedKeywords: document.querySelector("#derivedKeywords"),
  angleCount: document.querySelector("#angleCount"),
  productAngles: document.querySelector("#productAngles"),
  filterHot: document.querySelector("#filterHot"),
  filterConfidence: document.querySelector("#filterConfidence"),
  filterViews: document.querySelector("#filterViews"),
  filterRecent: document.querySelector("#filterRecent"),
  sortMode: document.querySelector("#sortMode"),
  clearCache: document.querySelector("#clearCache"),
  cacheStatus: document.querySelector("#cacheStatus"),
  quotaStatus: document.querySelector("#quotaStatus"),
  topUploadHour: document.querySelector("#topUploadHour"),
  topProductAngle: document.querySelector("#topProductAngle"),
  trendFarmingCount: document.querySelector("#trendFarmingCount"),
  timelineCount: document.querySelector("#timelineCount"),
  trendTimeline: document.querySelector("#trendTimeline"),
  heatmapCount: document.querySelector("#heatmapCount"),
  categoryHeatmap: document.querySelector("#categoryHeatmap"),
  emergingCount: document.querySelector("#emergingCount"),
  emergingProducts: document.querySelector("#emergingProducts"),
  historyCount: document.querySelector("#historyCount"),
  searchHistory: document.querySelector("#searchHistory"),
  loadingPanel: document.querySelector("#loadingPanel"),
  progressLabel: document.querySelector("#progressLabel"),
  loadingEta: document.querySelector("#loadingEta"),
  progressBar: document.querySelector("#progressBar"),
  toggleKeywordInsight: document.querySelector("#toggleKeywordInsight"),
  keywordInsightPanel: document.querySelector("#keywordInsightPanel")
};
let lastResearchData = null;
let currentShorts = [];
let loadingTimer = null;
const THEME_KEY = "trendScopeTheme";
const sectionState = {
  youtube: { visible: 3, items: [], error: "" },
  tiktok: { visible: 3, items: [], error: "" },
  shopee: { visible: 3, items: [], error: "" }
};
const HISTORY_KEY = "viralResearchHistory";

const FALLBACK_CATEGORIES = [
  "Alat Rumah Tangga",
  "Dapur",
  "Fashion Wanita",
  "Fashion Pria",
  "Gadget",
  "Aksesoris HP",
  "Baby & Kids",
  "Otomotif",
  "Kesehatan",
  "Olahraga",
  "Pet Shop",
  "Dekorasi Rumah",
  "Travel",
  "Elektronik Murah",
  "Peralatan Sekolah",
  "Peralatan Kantor",
  "Mainan Anak",
  "Perlengkapan Ibadah",
  "Aksesoris Wanita",
  "Tas & Dompet"
];

init();

async function init() {
  initTheme();
  initResultTabs();
  showShopeeCallbackMessage();
  try {
    const status = await fetchJson("/api/status");
    const usage = await fetchJson("/api/usage-status").catch(() => null);
    const shopeeStatus = await fetchJson("/api/shopee/status").catch(() => null);
    if (els.devBadge) els.devBadge.hidden = !status.devMode && !usage?.devUnlimited;
    updateConnectionBadges(status, shopeeStatus, usage);
    if (window.__shopeeCallbackMessage) els.status.textContent = window.__shopeeCallbackMessage;
    els.exportCsv.disabled = !status.exportEnabled;
    els.exportJson.disabled = !status.exportEnabled;
  } catch {
    els.status.textContent = "API status unavailable";
    setBadge(els.youtubeBadge, "YouTube Unknown", "warning");
    setBadge(els.shopeeBadge, "Shopee Unknown", "warning");
  }
  await loadCategories();
  await refreshCacheStatus();
  await refreshQuotaStatus();
  loadEmergingProducts();
  renderSearchHistory();
  renderRecentSearchChips();
  updateOnboarding();
  updateSearchMode();
}

function updateConnectionBadges(status, shopeeStatus, usage) {
  const youtubeReady = Boolean(status.youtubeConfigured);
  const shopeeConnected = Boolean(shopeeStatus?.authorized && shopeeStatus?.tokenStatus === "active");
  const shopeeWaiting = Boolean(shopeeStatus?.configured && !shopeeConnected);
  const quotaText = usage?.devUnlimited ? "Unlimited dev search" : `${usage?.remaining ?? status.dailySearchLimit}/${status.dailySearchLimit} search left`;
  setBadge(els.youtubeBadge, youtubeReady ? "YouTube Ready" : "YouTube Needs Key", youtubeReady ? "success" : "warning");
  setBadge(els.shopeeBadge, shopeeConnected ? "Shopee Connected" : shopeeWaiting ? "Waiting AMS" : "Shopee Setup", shopeeConnected ? "success" : "warning");
  if (els.youtubeKpiStatus) els.youtubeKpiStatus.textContent = youtubeReady ? "Ready" : "Setup";
  if (els.shopeeKpiStatus) els.shopeeKpiStatus.textContent = shopeeConnected ? "Connected" : "Waiting AMS";
  els.status.textContent = quotaText;
}

function setBadge(element, text, tone = "info") {
  if (!element) return;
  element.textContent = text;
  element.className = `status-badge status-${tone}`;
}

function initResultTabs() {
  document.querySelectorAll("[data-result-tab]").forEach((button) => {
    button.addEventListener("click", () => setActiveResultsTab(button.dataset.resultTab));
  });
  setActiveResultsTab("opportunities");
}

function setActiveResultsTab(tab) {
  document.querySelectorAll("[data-result-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.resultTab === tab);
  });
  document.querySelectorAll(".data-section[data-section]").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.section === tab);
  });
}

function showShopeeCallbackMessage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("shopee") !== "connected") return;
  const message = params.get("message") || "Shopee connected successfully";
  window.__shopeeCallbackMessage = message;
  if (els.status) els.status.textContent = message;
  if (els.researchStatus) els.researchStatus.textContent = message;
  if (els.researchStatus) setStatusTone(els.researchStatus, "success");
  const cleanUrl = `${window.location.pathname}${window.location.hash || ""}`;
  window.history.replaceState({}, document.title, cleanUrl);
}

function setResearchStatus(message, tone = "info") {
  if (!els.researchStatus) return;
  els.researchStatus.textContent = message;
  setStatusTone(els.researchStatus, tone);
}

function setStatusTone(element, tone = "info") {
  element.classList.remove("is-success", "is-warning", "is-error", "is-info");
  element.classList.add(`is-${tone}`);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "light";
  document.documentElement.dataset.theme = saved;
  updateThemeButton(saved);
}

function updateThemeButton(theme) {
  if (els.themeToggle) els.themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
}

els.themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem(THEME_KEY, next);
  updateThemeButton(next);
});

els.menuToggle?.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-open");
});

document.querySelectorAll(".side-nav a").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".side-nav a").forEach((item) => item.classList.remove("is-active"));
    link.classList.add("is-active");
    document.body.classList.remove("sidebar-open");
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".app-sidebar, .menu-toggle") && document.body.classList.contains("sidebar-open")) {
    document.body.classList.remove("sidebar-open");
  }
});

els.searchModes.forEach((mode) => {
  mode.addEventListener("change", updateSearchMode);
});

els.productKeyword.addEventListener("input", debounce(() => {
  if (getSearchMode() === "manual" && els.productKeyword.value.trim()) {
    els.researchStatus.textContent = "Keyword siap dicari. Klik Cari Peluang Viral.";
  }
}, 250));

document.addEventListener("click", (event) => {
  const category = event.target.closest("[data-category-jump]");
  if (category) {
    document.querySelector("input[name='searchMode'][value='category']").checked = true;
    updateSearchMode();
    els.categorySelect.value = category.dataset.categoryJump;
    els.productSearch.click();
    return;
  }
  const historyChip = event.target.closest("[data-history-chip]");
  if (historyChip) {
    document.querySelector(`input[name="searchMode"][value="${historyChip.dataset.mode || "manual"}"]`).checked = true;
    updateSearchMode();
    if (historyChip.dataset.mode === "category") els.categorySelect.value = historyChip.dataset.category || els.categorySelect.value;
    if (historyChip.dataset.mode === "manual") els.productKeyword.value = historyChip.dataset.keyword || "";
    els.productSearch.click();
  }
});

function updateSearchMode() {
  const mode = getSearchMode();
  els.categoryField.hidden = mode !== "category";
  els.productKeyword.closest("label").hidden = mode !== "manual";
}

function updateOnboarding() {
  if (!els.onboardingPanel) return;
  const hasResults = Number(els.youtubeTotal.textContent.replace(/\D/g, "") || 0) > 0 || Boolean(lastResearchData);
  els.onboardingPanel.hidden = hasResults;
}

if (els.search) els.search.addEventListener("click", async () => {
  const params = new URLSearchParams({
    niche: els.niche.value,
    platform: els.platform.value,
    days: els.days.value,
    limit: "12"
  });

  els.search.disabled = true;
  els.summary.textContent = "Mencari sinyal trend...";
  els.results.innerHTML = "";

  try {
    const data = await fetchJson(`/api/trends?${params}`);
    renderResponse(data);
  } catch (error) {
    els.summary.textContent = error.message;
  } finally {
    els.search.disabled = false;
  }
});

els.productSearch.addEventListener("click", async () => {
  const mode = getSearchMode();
  const keyword = els.productKeyword.value.trim();
  const category = els.categorySelect.value;
  const queryValue = mode === "auto" ? "auto" : mode === "category" ? category : keyword;

  if (!queryValue) {
    els.researchStatus.textContent = mode === "category" ? "Kategori wajib dipilih." : "Keyword wajib diisi untuk mode Manual.";
    return;
  }

  els.productSearch.disabled = true;
  startLoading(mode);
  els.tiktokRows.innerHTML = skeletonCards(3);
  els.youtubeRows.innerHTML = skeletonCards(6);
  els.shopeeRows.innerHTML = skeletonCards(3);
  setTotals(0, 0, 0);

  try {
    const data = await fetchJson("/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        keyword: mode === "manual" ? keyword : "",
        category: mode === "category" ? category : ""
      })
    });
    lastResearchData = data;
    renderResearch(data);
    saveSearchHistory({ mode, keyword, category, count: (data.shorts || []).length });
    renderRecentSearchChips();
    await refreshQuotaStatus();
    await refreshCacheStatus();
    updateOnboarding();
  } catch (error) {
    setResearchStatus(`Gagal memuat riset. ${error.message || "Coba lagi sebentar."}`, "error");
    els.tiktokRows.innerHTML = emptyMessage("Gagal menghitung peluang viral.");
    els.youtubeRows.innerHTML = emptyMessage("Gagal memuat YouTube.");
    els.shopeeRows.innerHTML = emptyMessage("Shopee belum mengambil data trends.");
  } finally {
    els.productSearch.disabled = false;
    stopLoading();
  }
});

function renderResearch(data) {
  const shorts = Array.isArray(data.shorts || data.youtube) ? data.shorts || data.youtube || [] : [];
  const products = Array.isArray(data.products || data.shopee) ? data.products || data.shopee || [] : [];
  const opportunities = Array.isArray(data.opportunities) ? data.opportunities : [];
  const recommendations = data.keywordRecommendations || data.keyword_recommendations || data.debug?.youtube?.flatMap((item) => item.keywordRecommendations || []) || buildClientKeywordRecommendations(shorts);
  const derived = data.topKeywordTurunan || recommendations;
  const angles = data.topProductAngles || buildClientAngles(shorts);
  const stats = data.stats || data.debug?.youtube?.find((item) => item?.stats)?.stats || buildClientStats(shorts, recommendations);
  currentShorts = shorts;
  resetSectionPaging();

  renderSource("youtube", applyVideoFilters(shorts), "");
  renderSource("shopee", products, "");
  renderSource("tiktok", opportunities, "");
  renderKeywordRecommendations(recommendations);
  renderChipList(els.derivedKeywords, els.derivedKeywordCount, derived, "keyword");
  renderChipList(els.productAngles, els.angleCount, angles, "angle");
  renderTopStats(stats);
  renderTrendIntelligence(data.analyticsSummary || stats);
  setTotals(opportunities.length, shorts.length, products.length);
  updateShopeeTrendBadge(products.length);
  setResearchStatus(formatResearchMessage(data.message || `Selesai. ${opportunities.length} peluang, ${shorts.length} video viral, ${products.length} trends Shopee.`), products.length ? "success" : "warning");
}

function updateShopeeTrendBadge(count) {
  if (count > 0) {
    setBadge(els.shopeeBadge, "Shopee Trends Ready", "success");
    if (els.shopeeKpiStatus) els.shopeeKpiStatus.textContent = "Active";
    return;
  }
  setBadge(els.shopeeBadge, "Waiting AMS", "warning");
  if (els.shopeeKpiStatus) els.shopeeKpiStatus.textContent = "Waiting AMS";
}

function formatResearchMessage(message) {
  return String(message || "")
    .replace(/produk Affiliate/gi, "trends Shopee")
    .replace(/Produk Affiliate/gi, "Trends Shopee")
    .replace(/Affiliate/gi, "Trends Shopee")
    .replace(/Shopee AMS API belum dikonfigurasi/gi, "Shopee belum mengambil data trends");
}

function formatSourceErrors(errors) {
  return errors.filter(Boolean).map(formatResearchMessage);
}

function resetSectionPaging() {
  Object.values(sectionState).forEach((state) => {
    state.visible = 3;
  });
}

async function renderProgressiveKeywordSearch(keyword) {
  const state = { keyword, youtube: [], shopee: [], errors: {} };
  const jobs = [
    loadSource("youtube", `/api/trends?${new URLSearchParams({ niche: keyword, platform: "youtube", days: "14", limit: "10" })}`, (data) => data.items || []),
    loadSource("shopee", "/api/shopee-performance", (data) => data.items || [])
  ];

  await Promise.allSettled(jobs.map((job) => job.run(state)));
  updateStatusFromState(state, true);
}

function loadSource(source, url, pickItems) {
  return {
    async run(state) {
      setSourceLoading(source);
      try {
        const data = await fetchJson(url);
        state[source] = pickItems(data);
        renderSource(source, state[source], "");
      } catch (error) {
        state.errors[source] = simpleSourceError(source);
        renderSource(source, [], state.errors[source]);
      } finally {
        updateTotalsFromState(state);
        updateStatusFromState(state, false);
      }
    }
  };
}

function setSourceLoading(source) {
  if (source === "tiktok") els.tiktokRows.innerHTML = emptyMessage("Menghitung peluang viral...");
  if (source === "youtube") els.youtubeRows.innerHTML = emptyMessage("Mengambil YT Viral...");
  if (source === "shopee") els.shopeeRows.innerHTML = emptyMessage("Mengambil trends Shopee...");
}

function renderSource(source, items, error) {
  sectionState[source] = sectionState[source] || { visible: 3, items: [], error: "" };
  sectionState[source].items = items || [];
  sectionState[source].error = error || "";
  sectionState[source].visible = Math.min(sectionState[source].visible || 3, Math.max(3, sectionState[source].items.length));
  renderSourcePage(source);
}

function renderSourcePage(source) {
  const state = sectionState[source];
  const items = state.items || [];
  const error = state.error || "";
  const visibleItems = items.slice(0, state.visible);
  const controls = renderShowMore(source, items.length, state.visible);
  if (source === "tiktok") {
    els.tiktokCount.textContent = `${items.length} match`;
    renderGrid(els.tiktokRows, items.length ? visibleItems.map((item) => renderOpportunityCard(item)).join("") + controls : emptyMessage(error || "Belum ada peluang viral.", "Coba keyword produk seperti gelas aesthetic, rak sepatu, atau gadget murah."));
  }
  if (source === "youtube") {
    els.youtubeCount.textContent = `${items.length} video`;
    renderGrid(els.youtubeRows, items.length ? visibleItems.map((item) => renderYouTubeCard(item)).join("") + controls : emptyMessage(error || "Tidak ada YT Viral.", "Coba keyword dengan intent jualan: review, racun, shopee, aesthetic, atau portable."));
  }
  if (source === "shopee") {
    els.shopeeCount.textContent = `${items.length} produk`;
    renderGrid(els.shopeeRows, items.length ? visibleItems.map((item) => renderShopeeCard(item)).join("") + controls : shopeePendingMessage(error));
  }
}

function shopeePendingMessage(error) {
  return emptyMessage(error || "Shopee Trends menunggu akses AMS", "Request AMS sudah dikirim. Data Shopee akan otomatis aktif setelah permission disetujui.");
}

function renderGrid(target, html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  target.replaceChildren(template.content.cloneNode(true));
}

function renderShowMore(source, total, visible) {
  if (total <= 3) return "";
  const done = visible >= total;
  return `<div class="show-more-wrap"><button class="show-more" type="button" data-source="${source}" data-action="${done ? "less" : "more"}">${done ? "Show less" : "Show more"}</button></div>`;
}

function updateTotalsFromState(state) {
  setTotals(0, state.youtube.length, state.shopee.length);
}

function updateStatusFromState(state, done) {
  const errors = Object.values(state.errors).filter(Boolean);
  const total = state.youtube.length + state.shopee.length;
  if (done) {
    setResearchStatus(errors.length
      ? `Selesai sebagian. ${errors.join(" | ")}`
      : `Selesai untuk keyword ${state.keyword}. ${total} hasil tampil.`, errors.length ? "warning" : "success");
    return;
  }
  setResearchStatus(`Hasil masuk bertahap... YT Viral ${state.youtube.length}, trends Shopee ${state.shopee.length}`, "info");
}

function simpleSourceError(source) {
  if (source === "shopee") return "Shopee belum mengambil data trends.";
  return "YouTube Shorts belum tersedia";
}

els.parse.addEventListener("click", () => {
  const items = parseCsv(els.csv.value).map((row) => {
    const views = number(row.views);
    const likes = number(row.likes);
    const comments = number(row.comments);
    const engagementRate = views ? (likes + comments * 2) / views : 0;
    return {
      title: row.title || "Untitled item",
      channel: "Video CSV",
      url: row.url || "",
      views,
      likes,
      comments,
      velocity: views,
      engagementRate,
      score: Math.round(views * (1 + engagementRate * 20))
    };
  }).sort((a, b) => b.score - a.score);

  renderResponse({ platform: "video-csv", configured: true, items });
});

function renderProductResearch(data) {
  const youtubeItems = Array.isArray(data.youtube) ? data.youtube : data.youtube?.items || [];
  const shopeeItems = Array.isArray(data.shopee) ? data.shopee : data.shopee?.items || [];
  const opportunities = data.opportunities || [];
  const errors = formatSourceErrors([
    ...(Array.isArray(data.errors) ? data.errors : []),
    data.errors?.youtube && `YouTube gagal: ${data.errors.youtube}`,
    data.errors?.shopee && `Trends Shopee gagal: ${formatResearchMessage(data.errors.shopee)}`,
    data.youtube?.error,
    data.shopee?.error,
    data.errors?.other && `Lainnya: ${data.errors.other}`
  ]);

  const context = data.category ? `kategori ${data.category}` : `keyword ${data.keyword || els.productKeyword.value}`;
  setResearchStatus(errors.length
    ? `Selesai dengan catatan: ${errors.join(" | ")}`
    : `Selesai untuk ${context}. Ditemukan ${youtubeItems.length} video viral, ${shopeeItems.length} trends Shopee, dan ${opportunities.length} peluang.`, errors.length ? "warning" : "success");

  els.tiktokCount.textContent = `${opportunities.length} match`;
  els.youtubeCount.textContent = `${youtubeItems.length} video`;
  els.shopeeCount.textContent = `${shopeeItems.length} produk`;
  setTotals(opportunities.length, youtubeItems.length, shopeeItems.length);
  resetSectionPaging();
  renderSource("tiktok", opportunities, "");
  renderSource("youtube", youtubeItems, errors.find((error) => error.startsWith("YouTube gagal")) || "");
  renderSource("shopee", shopeeItems, "");
}

function renderOpportunityCard(item) {
  const product = item.topProduct || item.product || null;
  const short = item.short || {};
  const merged = { ...short, ...item };
  const pending = !product;
  return `
    <article class="result-card">
      ${renderImage(short.thumbnail || item.image || product?.image, short.title || item.title || product?.name, "Shorts", short)}
      <div class="result-body">
        <div class="card-topline">${renderOpportunityBadge(merged)}<span class="score-pill">${formatChance(item.chance ?? item.score)} peluang</span></div>
        <h3>${escapeHtml(short.title || item.title || "Peluang viral")}</h3>
        ${renderIndicators(merged)}
        <p class="meta">Keyword produk: ${escapeHtml(item.keyword || item.matchedKeyword || "-")}</p>
        <p class="price">${escapeHtml(product?.name || "Menunggu validasi marketplace")}</p>
        ${renderStats([
          ["Terjual", product?.items_sold ?? product?.soldCount ?? "-"],
          ["Order", product?.orders ?? "-"],
          ["ROI", product?.roi ?? "-"],
          ["Peluang", formatChance(item.chance ?? item.score)]
        ])}
        ${renderBreakdown(merged)}
        ${renderWhyViral(merged)}
        <p class="meta">${escapeHtml(pending ? "Menunggu validasi marketplace" : item.reason || item.matchedShortTitle || "")}</p>
        <div class="button-row quick-actions">
          ${product ? renderOpenButton(product.url, "Buka Produk") : renderOpenButton(short.url || item.url, "Buka Shorts")}
          ${renderQuickActions(merged)}
        </div>
      </div>
    </article>
  `;
}

function renderShopeeCard(item) {
  const manual = item.validationStatus === "manual-keyword" || String(item.item_id || "").startsWith("manual-shopee");
  const realSearchProduct = item.validationStatus === "shopee-search-product";
  return `
    <article class="result-card">
      ${renderImage(item.image, item.name, "Shopee", item)}
      <div class="result-body">
        <div class="card-topline">${renderBadge(item.label)}<span class="score-pill">${formatNumber(item.score)} score</span></div>
        <h3>${escapeHtml(item.name)}</h3>
        <p class="price">${escapeHtml(manual ? "Validasi manual Shopee" : item.price || (item.sales ? `Sales ${formatCurrency(item.sales)}` : "Sales belum tersedia"))}</p>
        <p class="meta">${escapeHtml(manual ? item.reason || "Klik Cari di Shopee untuk cek produk." : realSearchProduct ? item.reason || "Produk real dari hasil pencarian Shopee." : `Estimasi komisi: ${formatCurrency(item.est_commission || 0)}`)}</p>
        ${renderStats(realSearchProduct ? [
          ["Total Penjualan", item.soldCount || item.items_sold || 0],
          ["Rating", item.rating ? Number(item.rating).toFixed(1) : "-"],
          ["Ulasan", item.reviewCount || 0],
          ["Toko", item.shopName || "-"],
          ["Peluang", formatChance(item.chance ?? item.score)]
        ] : [
          ["Terjual", item.items_sold ?? item.soldCount],
          ["Order", item.orders],
          ["Clicks", item.clicks],
          ["ROI", item.roi],
          ["Buyer Baru", item.new_buyers],
          ["Peluang", formatChance(item.chance ?? item.score)]
        ])}
        <div class="button-row quick-actions">${renderOpenButton(item.url, manual ? "Cari di Shopee" : "Buka Produk")}${renderQuickActions(item)}</div>
      </div>
    </article>
  `;
}

function renderYouTubeCard(item) {
  return `
    <article class="result-card">
      ${renderImage(item.thumbnail, item.title, "YouTube", item)}
      <div class="result-body">
        <div class="card-topline">${renderOpportunityBadge(item)}<span class="score-pill">${formatChance(item.product_confidence ?? item.product_score ?? item.viral_score ?? item.score)} confidence</span></div>
        <h3>${escapeHtml(item.title)}</h3>
        ${renderIndicators(item)}
        <p class="meta">Niche: ${escapeHtml(item.auto_niche || "-")} | Audience: ${escapeHtml(item.target_audience || "-")}</p>
        <p class="meta">${escapeHtml(item.channel || "YouTube channel")} • ${escapeHtml(item.estimated_product_type || "produk viral")}</p>
        ${renderStats([
          ["Views", item.views],
          ["Likes", item.likes],
          ["Engagement", formatChance((item.engagementRate || 0) * 100)],
          ["Confidence", formatChance(item.product_confidence ?? item.product_score ?? 0)],
          ["Trend", formatChance(item.trend_score_final ?? 0)],
          ["Level", item.virality_level || "-"],
          ["Selling", formatChance(item.estimated_selling_power ?? 0)],
          ["Comments", item.comments],
          ["Durasi", item.durationSeconds ? `${item.durationSeconds}s` : "-"],
          ["Upload", formatDate(item.publishedAt)],
          ["Viral", formatChance(item.viral_score ?? item.score)],
          ["Produk", formatChance(item.product_score ?? 0)]
        ])}
        ${renderBreakdown(item)}
        ${renderHooks(item)}
        <p class="meta"><strong>CTA:</strong> ${escapeHtml(item.cta_recommendation || "-")}</p>
        ${renderWhyViral(item)}
        <p class="meta"><strong>Related:</strong> ${escapeHtml((item.related_product_recommendation || []).join(", ") || "-")}</p>
        <div class="button-row quick-actions">${renderOpenButton(item.url, "Buka Video")}${renderQuickActions(item)}</div>
      </div>
    </article>
  `;
}

function renderBadge(label) {
  const safe = escapeHtml(label || "LOW");
  return `<span class="badge badge-${safe.toLowerCase()}">${safe}</span>`;
}

function renderOpportunityBadge(item) {
  return renderBadge(item.opportunity_score_label || item.confidence_label || item.label || confidenceLabel(item.product_confidence));
}

function renderIndicators(item) {
  const indicators = item.visual_indicators || buildClientIndicators(item);
  if (!indicators.length) return "";
  return `<div class="indicator-row">${indicators.slice(0, 4).map((label) => `<span>${escapeHtml(label)}</span>`).join("")}</div>`;
}

function renderBreakdown(item) {
  const breakdown = item.confidence_breakdown;
  if (!breakdown) return "";
  const rows = [
    ["Keyword", breakdown.keywordScore],
    ["Engage", breakdown.engagementScore],
    ["Recent", breakdown.recencyScore],
    ["Shopee", breakdown.affiliateIntentScore]
  ];
  return `<div class="breakdown">${rows.map(([label, value]) => `
    <div>
      <span>${label}</span>
      <strong>${formatChance(value || 0)}</strong>
      <i style="width:${Math.max(0, Math.min(100, Number(value || 0)))}%"></i>
    </div>
  `).join("")}</div>`;
}

function renderWhyViral(item) {
  const reasons = item.why_this_is_viral || (item.why_viral ? [item.why_viral] : []);
  if (!reasons.length) return "";
  return `<div class="why-box"><strong>Why this is viral</strong><ul>${reasons.slice(0, 4).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>`;
}

function renderHooks(item) {
  const hooks = item.viral_hooks || [];
  if (!hooks.length) return "";
  return `<div class="hook-row">${hooks.slice(0, 5).map((hook) => `<span>${escapeHtml(hook)}</span>`).join("")}</div>`;
}

function renderQuickActions(item) {
  const keyword = item.parent_keyword || item.keyword || item.estimated_product_type || (item.important_keywords || [])[0] || item.title || "";
  const encoded = encodeURIComponent(keyword);
  return `
    <button class="mini-action" type="button" data-copy-keyword="${escapeHtml(keyword)}">Copy Keyword</button>
    <a class="mini-action" href="https://shopee.co.id/search?keyword=${encoded}" target="_blank" rel="noreferrer">Cari di Shopee</a>
    <a class="mini-action" href="https://www.tiktok.com/search?q=${encoded}" target="_blank" rel="noreferrer">TikTok</a>
    <a class="mini-action" href="https://www.youtube.com/results?search_query=${encoded}" target="_blank" rel="noreferrer">YouTube</a>
  `;
}

function rowMessage(columns, message) {
  return `<tr class="empty-row"><td colspan="${columns}">${escapeHtml(message)}</td></tr>`;
}

function emptyMessage(message, recommendation = "Coba keyword produk yang lebih spesifik, misalnya gelas viral shopee atau alat dapur unik.") {
  return `
    <div class="empty-state">
      <span class="empty-icon">?</span>
      <strong>${escapeHtml(message)}</strong>
      <small>${escapeHtml(recommendation)}</small>
    </div>
  `;
}

function skeletonCards(count) {
  return Array.from({ length: count }).map(() => `
    <article class="result-card skeleton-card">
      <div class="thumb skeleton-block"></div>
      <div class="result-body">
        <div class="skeleton-line short"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-grid">
          <span></span><span></span><span></span><span></span>
        </div>
      </div>
    </article>
  `).join("");
}

function startLoading(mode) {
  const steps = [
    ["Mencari keyword...", 18, 8],
    ["Mengambil video...", 42, 6],
    ["Scoring produk...", 68, 4],
    ["Filtering hasil...", 88, 2]
  ];
  let index = 0;
  els.loadingPanel.hidden = false;
  els.productSearch.classList.add("is-loading");
  setProgress(steps[index]);
  setResearchStatus(mode === "auto"
    ? "Mencari YT Viral..."
    : mode === "category" ? "Mencari peluang viral dari kategori..." : "Mencari video viral dan produk dari keyword...", "info");
  clearInterval(loadingTimer);
  loadingTimer = setInterval(() => {
    index = Math.min(index + 1, steps.length - 1);
    setProgress(steps[index]);
  }, 1600);
}

function setProgress([label, percent, eta]) {
  els.progressLabel.textContent = label;
  els.progressBar.style.width = `${percent}%`;
  els.loadingEta.textContent = `Estimasi ${eta} detik`;
}

function stopLoading() {
  clearInterval(loadingTimer);
  loadingTimer = null;
  els.progressBar.style.width = "100%";
  els.loadingEta.textContent = "Selesai";
  els.productSearch.classList.remove("is-loading");
  setTimeout(() => {
    els.loadingPanel.hidden = true;
    els.progressBar.style.width = "0%";
  }, 450);
}

function renderImage(src, alt, fallbackText, item = {}) {
  const imageUrl = resolveImageUrl(src, item);
  if (!imageUrl) return `<div class="thumb placeholder-thumb"><span>${escapeHtml(fallbackText)}</span></div>`;
  return `<img class="thumb" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt || "")}" loading="lazy" decoding="async" data-fallback="${escapeHtml(fallbackText)}" onerror="replaceBrokenImage(this)">`;
}

function resolveImageUrl(src, item = {}) {
  if (typeof src === "string" && src) return src;
  if (src && typeof src === "object") {
    const nested = src.url || src.high?.url || src.medium?.url || src.default?.url;
    if (nested) return nested;
  }
  const videoId = getYouTubeVideoId(item.id || item.videoId || item.url || "");
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "";
}

function getYouTubeVideoId(value) {
  const text = String(value || "");
  if (/^[\w-]{11}$/.test(text)) return text;
  const shortsMatch = text.match(/\/shorts\/([\w-]{11})/);
  if (shortsMatch) return shortsMatch[1];
  const watchMatch = text.match(/[?&]v=([\w-]{11})/);
  if (watchMatch) return watchMatch[1];
  const embedMatch = text.match(/\/embed\/([\w-]{11})/);
  return embedMatch ? embedMatch[1] : "";
}

function renderStats(stats) {
  return `
    <dl class="stat-grid">
      ${stats.map(([label, value]) => `
        <div>
          <dt>${escapeHtml(label)}</dt>
          <dd>${typeof value === "number" ? formatNumber(value) : escapeHtml(value)}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

function renderOpenButton(url, label) {
  return url ? `<a class="open-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>` : "-";
}

function setTotals(tiktok, youtube, shopee) {
  els.tiktokTotal.textContent = formatNumber(tiktok);
  els.youtubeTotal.textContent = formatNumber(youtube);
  els.shopeeTotal.textContent = formatNumber(shopee);
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

async function loadCategories() {
  renderCategoryOptions(FALLBACK_CATEGORIES);

  try {
    const data = await fetchJson("/api/categories");
    if (Array.isArray(data.categories) && data.categories.length) {
      renderCategoryOptions(data.categories);
    }
  } catch {
    renderCategoryOptions(FALLBACK_CATEGORIES);
  }
}

function renderCategoryOptions(categories) {
  els.categorySelect.innerHTML = categories
    .map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
    .join("");
}

function getSearchMode() {
  return document.querySelector("input[name='searchMode']:checked")?.value || "auto";
}

function renderResponse(data) {
  if (data.message) {
    els.summary.textContent = data.message;
  } else if (!data.items.length) {
    els.summary.textContent = "Belum ada hasil untuk filter ini.";
  } else {
    const top = data.items[0];
    els.summary.textContent = `${data.items.length} hasil ditemukan. Sinyal terkuat: ${top.title}`;
  }

  els.results.innerHTML = data.items.map(renderCard).join("");
}

function renderCard(item) {
  const image = item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : "";
  const url = item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Buka</a>` : "";

  return `
    <article class="card">
      ${image}
      <div class="card-body">
        <div class="score">${formatNumber(item.score)} score</div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.channel || "")}</p>
        <dl>
          <div><dt>Views</dt><dd>${formatNumber(item.views)}</dd></div>
          <div><dt>Likes</dt><dd>${formatNumber(item.likes)}</dd></div>
          <div><dt>Comments</dt><dd>${formatNumber(item.comments)}</dd></div>
          <div><dt>Velocity</dt><dd>${formatNumber(item.velocity)}/jam</dd></div>
        </dl>
        ${url}
      </div>
    </article>
  `;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((header) => header.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function splitCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;

  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value.trim());
  return values;
}

function number(value) {
  return Number(String(value || "0").replace(/[^\d.]/g, "")) || 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function formatChance(value) {
  const number = Number(value || 0);
  return `${Math.max(0, Math.min(100, Math.round(number)))}%`;
}

function confidenceLabel(value) {
  const score = Number(value || 0);
  if (score >= 80) return "HOT";
  if (score >= 60) return "GOOD";
  return "LOW";
}

function renderTopStats(stats) {
  els.avgViews.textContent = formatNumber(stats.averageViews || 0);
  els.avgEngagement.textContent = formatChance((stats.averageEngagement || 0) * 100);
  els.topKeyword.textContent = stats.topKeyword || "-";
}

function renderTrendIntelligence(stats = {}) {
  if (!els.topUploadHour) return;
  const timeline = stats.uploadDistributionByHour || [];
  const heatmap = stats.trendCategoryHeatmap || [];
  const farming = stats.trendFarmingChannels || [];
  els.topUploadHour.textContent = stats.topUploadHour || "-";
  els.topProductAngle.textContent = stats.topProductAngle || "-";
  els.trendFarmingCount.textContent = formatNumber(farming.length || 0);
  els.timelineCount.textContent = `${timeline.length} slot`;
  els.heatmapCount.textContent = `${heatmap.length} kategori`;
  els.trendTimeline.innerHTML = timeline.length ? timeline.slice(0, 12).map((item) => {
    const width = Math.max(12, Math.min(100, Number(item.count || 0) * 18));
    return `<div class="timeline-row"><span>${escapeHtml(item.value)}</span><i><b style="width:${width}%"></b></i><strong>${formatNumber(item.count)}</strong></div>`;
  }).join("") : emptyMini("Belum ada timeline.");
  els.categoryHeatmap.innerHTML = heatmap.length ? heatmap.map((item) => (
    `<div class="heat-cell" style="--heat:${Number(item.intensity || 0)}"><span>${escapeHtml(item.category)}</span><strong>${formatNumber(item.count)}</strong></div>`
  )).join("") : emptyMini("Belum ada heatmap.");
}

async function loadEmergingProducts() {
  if (!els.emergingProducts) return;
  try {
    const data = await fetchJson("/api/trending/discover");
    const items = data.emergingProducts || [];
    els.emergingCount.textContent = `${items.length} produk`;
    els.emergingProducts.innerHTML = items.length
      ? items.slice(0, 8).map(renderEmergingItem).join("")
      : emptyMessage("Belum ada produk baru naik.", "Discovery akan memakai cache harian agar quota YouTube tetap hemat.");
  } catch (error) {
    els.emergingCount.textContent = "0 produk";
    els.emergingProducts.innerHTML = emptyMessage("Produk Baru Naik belum tersedia.", error.message || "Coba lagi setelah API YouTube siap.");
  }
}

function renderEmergingItem(item) {
  return `
    <article class="emerging-card">
      <div class="card-topline">
        ${renderBadge(item.lifecycle || "EARLY")}
        <span class="score-pill">${formatChance(item.momentum_score)} momentum</span>
      </div>
      <h3>${escapeHtml(item.keyword || "-")}</h3>
      <p class="meta">${escapeHtml(item.title || "")}</p>
      <dl class="mini-metrics">
        <div><dt>Avg views</dt><dd>${formatNumber(item.avg_views || item.views || 0)}</dd></div>
        <div><dt>Confidence</dt><dd>${formatChance(item.confidence || item.product_confidence || 0)}</dd></div>
        <div><dt>Top hook</dt><dd>${escapeHtml(item.top_hook || "-")}</dd></div>
      </dl>
      <div class="button-row quick-actions">
        ${renderOpenButton(item.url, "Buka Video")}
        ${renderQuickActions({ ...item, parent_keyword: item.keyword })}
      </div>
    </article>
  `;
}

function emptyMini(message) {
  return `<p class="mini-empty">${escapeHtml(message)}</p>`;
}

function renderKeywordRecommendations(items) {
  const keywords = (items || []).filter(Boolean).slice(0, 8);
  els.keywordCount.textContent = `${keywords.length} keyword`;
  els.keywordRecommendations.innerHTML = keywords.length
    ? keywords.map((item) => `<button class="keyword-chip" type="button" data-keyword="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")
    : emptyMessage("Belum ada rekomendasi keyword.");
}

function renderChipList(container, counter, items, suffix) {
  const values = (items || []).filter(Boolean).slice(0, 8);
  counter.textContent = `${values.length} ${suffix}`;
  container.innerHTML = values.length
    ? values.map((item) => `<button class="keyword-chip" type="button" data-keyword="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")
    : emptyMessage(`Belum ada ${suffix}.`);
}

function buildClientStats(shorts, recommendations) {
  const totalViews = shorts.reduce((sum, item) => sum + Number(item.views || 0), 0);
  const totalEngagement = shorts.reduce((sum, item) => sum + Number(item.engagementRate || 0), 0);
  return {
    averageViews: shorts.length ? Math.round(totalViews / shorts.length) : 0,
    averageEngagement: shorts.length ? totalEngagement / shorts.length : 0,
    topKeyword: recommendations[0] || ""
  };
}

function buildClientKeywordRecommendations(shorts) {
  return shorts.flatMap((item) => item.important_keywords || item.extractedKeywords || [])
    .filter((item, index, array) => item && array.indexOf(item) === index)
    .slice(0, 8);
}

function buildClientAngles(shorts) {
  const text = shorts.map((item) => `${item.title} ${(item.important_keywords || []).join(" ")}`).join(" ").toLowerCase();
  return ["aesthetic", "multifungsi", "portable", "murah", "viral tiktok", "unik", "review", "unboxing"]
    .filter((item) => text.includes(item.replace("viral tiktok", "tiktok")) || text.includes(item))
    .slice(0, 8);
}

function buildClientIndicators(item) {
  const ageDays = item.publishedAt ? (Date.now() - new Date(item.publishedAt).getTime()) / 864e5 : 999;
  return [
    Number(item.engagementRate || 0) >= 0.035 ? "high engagement" : "",
    ageDays <= 30 ? "recent upload" : "",
    Number(item.commercial_intent || item.product_intent_score || 0) >= 60 ? "affiliate intent" : ""
  ].filter(Boolean);
}

function applyVideoFilters(shorts) {
  const now = Date.now();
  return shorts.filter((item) => {
    if (els.filterHot.checked && (item.confidence_label || confidenceLabel(item.product_confidence)) !== "HOT") return false;
    if (els.filterConfidence.checked && Number(item.product_confidence || 0) <= 70) return false;
    if (els.filterViews.checked && Number(item.views || 0) <= 100000) return false;
    if (els.filterRecent.checked) {
      const ageDays = (now - new Date(item.publishedAt || 0).getTime()) / 864e5;
      if (!(ageDays >= 0 && ageDays < 30)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (els.sortMode.value === "viral") return Number(b.velocity || 0) - Number(a.velocity || 0);
    if (els.sortMode.value === "engagement") return Number(b.engagementRate || 0) - Number(a.engagementRate || 0);
    return Number(b.product_confidence || 0) - Number(a.product_confidence || 0);
  });
}

els.copyKeywords.addEventListener("click", async () => {
  const keywords = Array.from(els.keywordRecommendations.querySelectorAll("[data-keyword]")).map((item) => item.dataset.keyword);
  if (!keywords.length) return;
  await navigator.clipboard.writeText(keywords.join("\n"));
  els.researchStatus.textContent = "Keyword viral berhasil disalin.";
});

els.exportJson.addEventListener("click", () => {
  if (!lastResearchData) return;
  const blob = new Blob([JSON.stringify(buildExportRows(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `viral-research-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
});

els.exportCsv.addEventListener("click", () => {
  if (!lastResearchData) return;
  const csv = buildExportCsv();
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `viral-research-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

els.copyExport.addEventListener("click", async () => {
  if (!lastResearchData) return;
  await navigator.clipboard.writeText(buildExportCsv());
  els.researchStatus.textContent = "Data export berhasil disalin ke clipboard.";
});

els.clearCache.addEventListener("click", async () => {
  els.clearCache.disabled = true;
  try {
    await fetchJson("/api/cache-clear", { method: "POST" });
    await refreshCacheStatus();
    els.researchStatus.textContent = "Cache berhasil dibersihkan.";
  } catch (error) {
    els.researchStatus.textContent = error.message;
  } finally {
    els.clearCache.disabled = false;
  }
});

async function refreshCacheStatus() {
  try {
    const data = await fetchJson("/api/cache-status");
    els.cacheStatus.textContent = `Cache: ${data.activeCount || 0} aktif, ${data.expiredCount || 0} expired.`;
  } catch {
    els.cacheStatus.textContent = "Cache status belum tersedia.";
  }
}

async function refreshQuotaStatus() {
  try {
    const data = await fetchJson("/api/quota-status");
    els.quotaStatus.textContent = `Quota: ${data.youtubeRequestsToday || 0} request hari ini, cache hit ${data.cacheHitRate || 0}%, estimasi ${data.estimatedQuotaUnitsToday || 0} unit.`;
  } catch {
    els.quotaStatus.textContent = "Quota status belum tersedia.";
  }
}

function saveSearchHistory({ mode, keyword, category, count }) {
  const item = {
    mode,
    keyword,
    category,
    count,
    timestamp: Date.now()
  };
  const next = [item].concat(loadSearchHistory())
    .filter((entry, index, array) => array.findIndex((other) => historyKey(other) === historyKey(entry)) === index)
    .slice(0, 20);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  renderSearchHistory();
}

function loadSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function renderSearchHistory() {
  const items = loadSearchHistory();
  els.historyCount.textContent = `${items.length} pencarian`;
  els.searchHistory.innerHTML = items.length ? items.map((item, index) => `
    <button class="history-item" type="button" data-index="${index}">
      <strong>${escapeHtml(item.mode === "category" ? item.category : item.keyword || "Auto Discover")}</strong>
      <span>${escapeHtml(item.mode)} | ${formatDateTime(item.timestamp)} | ${formatNumber(item.count || 0)} hasil</span>
    </button>
  `).join("") : emptyMessage("Belum ada riwayat pencarian.");
}

function renderRecentSearchChips() {
  if (!els.recentSearchChips) return;
  const history = loadSearchHistory().slice(0, 4);
  const label = "<span>Recent searches</span>";
  els.recentSearchChips.innerHTML = label + (history.length
    ? history.map((item) => `<button type="button" data-history-chip="${escapeHtml(String(item.index || ""))}" data-mode="${escapeHtml(item.mode)}" data-keyword="${escapeHtml(item.keyword || "")}" data-category="${escapeHtml(item.category || "")}">${escapeHtml(item.category || item.keyword || item.mode)}</button>`).join("")
    : `<small>Belum ada riwayat.</small>`);
}

function historyKey(item) {
  return `${item.mode}:${item.keyword || ""}:${item.category || ""}`.toLowerCase();
}

els.searchHistory.addEventListener("click", (event) => {
  const button = event.target.closest("[data-index]");
  if (!button) return;
  const item = loadSearchHistory()[Number(button.dataset.index)];
  if (!item) return;
  document.querySelector(`input[name="searchMode"][value="${item.mode}"]`).checked = true;
  updateSearchMode();
  if (item.mode === "manual") els.productKeyword.value = item.keyword || "";
  if (item.mode === "category") els.categorySelect.value = item.category || els.categorySelect.value;
  els.productSearch.click();
});

function formatDateTime(value) {
  return new Date(value).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

[els.filterHot, els.filterConfidence, els.filterViews, els.filterRecent, els.sortMode].forEach((control) => {
  control.addEventListener("change", () => {
    sectionState.youtube.visible = 3;
    renderSource("youtube", applyVideoFilters(currentShorts), "");
  });
});

document.addEventListener("click", (event) => {
  const button = event.target.closest(".show-more");
  if (!button) return;
  const source = button.dataset.source;
  if (!sectionState[source]) return;
  sectionState[source].visible = button.dataset.action === "less"
    ? 3
    : Math.min(sectionState[source].visible + 3, sectionState[source].items.length);
  renderSourcePage(source);
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-keyword]");
  if (!button) return;
  const keyword = button.dataset.copyKeyword || "";
  if (!keyword) return;
  await navigator.clipboard.writeText(keyword);
  els.researchStatus.textContent = `Keyword disalin: ${keyword}`;
});

document.addEventListener("click", (event) => {
  const heading = event.target.closest(".data-section .section-heading");
  if (!heading || window.innerWidth > 700) return;
  const section = heading.closest(".data-section");
  section.classList.toggle("is-collapsed");
});

if (els.toggleKeywordInsight) {
  els.toggleKeywordInsight.addEventListener("click", () => {
    const nextHidden = !els.keywordInsightPanel.hidden;
    els.keywordInsightPanel.hidden = nextHidden;
    els.toggleKeywordInsight.textContent = nextHidden ? "Lihat insight keyword" : "Sembunyikan insight keyword";
  });
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function buildExportRows() {
  return (lastResearchData?.shorts || []).map((item) => ({
    title: item.title || "",
    views: Number(item.views || 0),
    likes: Number(item.likes || 0),
    confidence: Number(item.product_confidence ?? item.product_score ?? 0),
    keyword: (item.important_keywords || item.extractedKeywords || [])[0] || "",
    niche: item.auto_niche || "",
    url: item.url || ""
  }));
}

function buildExportCsv() {
  const rows = [["title", "views", "likes", "confidence", "keyword", "niche", "url"]]
    .concat(buildExportRows().map((item) => [
      item.title,
      item.views,
      item.likes,
      item.confidence,
      item.keyword,
      item.niche,
      item.url
    ]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function formatCurrency(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function debounce(fn, wait = 250) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

function replaceBrokenImage(image) {
  const fallback = image.dataset.fallback || "Image";
  const node = document.createElement("div");
  node.className = "thumb placeholder-thumb";
  node.innerHTML = `<span>${escapeHtml(fallback)}</span>`;
  image.replaceWith(node);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}
