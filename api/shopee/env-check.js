const ENV_NAMES_EXPECTED = [
  "SHOPEE_AFFILIATE_APP_ID",
  "SHOPEE_AFFILIATE_SECRET",
  "SHOPEE_APP_ID",
  "SHOPEE_APP_SECRET",
  "SHOPEE_AFFILIATE_GRAPHQL_URL"
];

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const envFound = ENV_NAMES_EXPECTED.filter((name) => hasEnv(name));
  const envMissing = ENV_NAMES_EXPECTED.filter((name) => !hasEnv(name));
  const appIdSource = hasEnv("SHOPEE_AFFILIATE_APP_ID")
    ? "SHOPEE_AFFILIATE_APP_ID"
    : hasEnv("SHOPEE_APP_ID")
      ? "SHOPEE_APP_ID"
      : null;
  const secretSource = hasEnv("SHOPEE_AFFILIATE_SECRET")
    ? "SHOPEE_AFFILIATE_SECRET"
    : hasEnv("SHOPEE_APP_SECRET")
      ? "SHOPEE_APP_SECRET"
      : null;

  return res.status(200).json({
    ok: Boolean(appIdSource && secretSource),
    env_names_expected: ENV_NAMES_EXPECTED,
    env_found: envFound,
    env_missing: envMissing,
    effective_config: {
      app_id_source: appIdSource,
      secret_source: secretSource,
      graphql_url_source: hasEnv("SHOPEE_AFFILIATE_GRAPHQL_URL") ? "SHOPEE_AFFILIATE_GRAPHQL_URL" : "default",
      graphql_url_default: "https://open-api.affiliate.shopee.co.id/graphql"
    },
    required_to_work: {
      app_id: "Isi salah satu: SHOPEE_AFFILIATE_APP_ID atau SHOPEE_APP_ID",
      secret: "Isi salah satu: SHOPEE_AFFILIATE_SECRET atau SHOPEE_APP_SECRET",
      graphql_url: "Opsional. Jika kosong, default ke https://open-api.affiliate.shopee.co.id/graphql"
    },
    safe_note: "Endpoint ini hanya menampilkan nama env yang ada/tidak ada. Nilai env dan secret tidak ditampilkan."
  });
};

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}
