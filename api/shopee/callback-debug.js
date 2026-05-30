module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");
  const cookies = parseCookies(req);
  const debug = parseCallbackDebug(cookies.SHOPEE_CALLBACK_DEBUG);

  if (!debug) {
    return res.status(200).json({
      received_access_token: false,
      received_refresh_token: false,
      received_shop_id: false,
      storage_write_success: false,
      error: "Callback debug cookie tidak ditemukan. Jalankan /api/shopee/auth lalu authorize ulang."
    });
  }

  return res.status(200).json({
    received_access_token: Boolean(debug.received_access_token),
    received_refresh_token: Boolean(debug.received_refresh_token),
    received_shop_id: Boolean(debug.received_shop_id),
    storage_write_success: Boolean(debug.storage_write_success),
    error: debug.storage_write_success ? null : "Callback menerima response tetapi cookie storage tidak lengkap."
  });
};

function parseCookies(req) {
  const header = String(req.headers?.cookie || "");
  return header.split(";").reduce((acc, item) => {
    const index = item.indexOf("=");
    if (index === -1) return acc;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function parseCallbackDebug(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
