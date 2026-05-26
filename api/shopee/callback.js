module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = getQuery(req);

  return res.status(200).json({
    ok: true,
    message: "Shopee callback route aktif. Token exchange belum dijalankan untuk test.",
    code: cleanValue(query.code),
    shop_id: cleanValue(query.shop_id || query.shopid),
    main_account_id: cleanValue(query.main_account_id),
    query
  });
};

function getQuery(req) {
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `https://${host}`);
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return query;
}

function cleanValue(value) {
  return String(value || "").trim();
}
