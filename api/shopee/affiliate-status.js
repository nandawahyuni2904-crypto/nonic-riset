const { probeShopeeAffiliateEndpoints } = require("../../services/shopeeAffiliateDiscovery");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const appId = String(process.env.SHOPEE_AFFILIATE_APP_ID || process.env.SHOPEE_APP_ID || "").trim();
  const secret = String(process.env.SHOPEE_AFFILIATE_SECRET || process.env.SHOPEE_APP_SECRET || "").trim();
  const graphqlUrl = String(process.env.SHOPEE_AFFILIATE_GRAPHQL_URL || "https://open-api.affiliate.shopee.co.id/graphql").trim();
  const query = cleanText(req.query?.keyword || req.query?.query || "gelas");

  if (!appId || !secret) {
    return res.status(200).json({
      ok: false,
      status: "missing_affiliate_credentials",
      shopee_affiliate_app_id_exists: Boolean(appId),
      shopee_affiliate_secret_exists: Boolean(secret),
      affiliate_token_valid: false,
      graphql_url: graphqlUrl,
      total_product_offer: 0,
      sample_10_product_title: [],
      setup_steps: buildSetupSteps(),
      env_needed: [
        "SHOPEE_AFFILIATE_APP_ID",
        "SHOPEE_AFFILIATE_SECRET"
      ],
      note: "Shopee Trends marketplace-wide belum bisa aktif sampai Shopee Affiliate Open API mengembalikan productOfferV2."
    });
  }

  try {
    const result = await probeShopeeAffiliateEndpoints({
      query,
      limit: 20
    });
    const productOfferCandidates = (result.candidates || []).filter((candidate) => candidate.graphql_field === "productOfferV2");
    const totalProductOffer = productOfferCandidates.reduce((sum, candidate) => sum + Number(candidate.product_count || 0), 0);
    const samples = productOfferCandidates
      .flatMap((candidate) => candidate.first_20_products || candidate.sample_products || [])
      .map((item) => item.title || item.item_name || item.name || "")
      .filter(Boolean)
      .slice(0, 10);
    const errors = productOfferCandidates
      .map((candidate) => candidate.error)
      .filter(Boolean);

    return res.status(200).json({
      ok: totalProductOffer > 0,
      status: totalProductOffer > 0 ? "affiliate_product_offer_ready" : "affiliate_product_offer_empty_or_failed",
      shopee_affiliate_app_id_exists: Boolean(appId),
      shopee_affiliate_secret_exists: Boolean(secret),
      affiliate_token_valid: totalProductOffer > 0,
      graphql_url: graphqlUrl,
      keyword_tested: query,
      total_product_offer: totalProductOffer,
      sample_10_product_title: samples,
      product_offer_endpoints: productOfferCandidates.map((candidate) => ({
        name: candidate.name,
        endpoint: candidate.endpoint,
        graphql_field: candidate.graphql_field,
        response_status: candidate.response_status,
        product_count: candidate.product_count || 0,
        sample_10_product_title: (candidate.first_20_products || candidate.sample_products || [])
          .map((item) => item.title || item.item_name || item.name || "")
          .filter(Boolean)
          .slice(0, 10),
        error: candidate.error || null,
        response_body_preview: candidate.response_body_preview || ""
      })),
      errors,
      setup_steps: totalProductOffer > 0 ? [] : buildSetupSteps(),
      note: totalProductOffer > 0
        ? "Affiliate Open API siap dipakai sebagai sumber Shopee Trends marketplace-wide."
        : "Credential ada, tetapi productOfferV2 belum mengembalikan produk. Cek error/permission Affiliate Marketing Solution Management di Shopee Open Platform."
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      status: "affiliate_status_check_failed",
      shopee_affiliate_app_id_exists: Boolean(appId),
      shopee_affiliate_secret_exists: Boolean(secret),
      affiliate_token_valid: false,
      graphql_url: graphqlUrl,
      total_product_offer: 0,
      sample_10_product_title: [],
      error: error.message,
      setup_steps: buildSetupSteps()
    });
  }
};

function buildSetupSteps() {
  return [
    "Buka Shopee Open Platform Console.",
    "Pastikan app category adalah Affiliate Marketing Solution Management.",
    "Minta/aktifkan akses Shopee Affiliate Open API, bukan hanya Seller/AMS basic.",
    "Ambil App ID dan Secret untuk Affiliate Open API.",
    "Isi Vercel Environment Variables: SHOPEE_AFFILIATE_APP_ID dan SHOPEE_AFFILIATE_SECRET.",
    "Redeploy Vercel setelah env disimpan.",
    "Test endpoint /api/shopee/affiliate-status?keyword=gelas.",
    "Jika total_product_offer > 0, baru lanjut integrasi Shopee Trends marketplace-wide."
  ];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
