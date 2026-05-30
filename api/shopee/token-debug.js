const fs = require("node:fs");
const path = require("node:path");

const TMP_TOKEN_PATH = path.join("/tmp", "shopee-token.json");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const tmpToken = readTmpToken();
  const envAccessToken = String(process.env.SHOPEE_ACCESS_TOKEN || "").trim();
  const envRefreshToken = String(process.env.SHOPEE_REFRESH_TOKEN || "").trim();
  const envShopId = String(process.env.SHOPEE_SHOP_ID || "").trim();
  const tmpAccessToken = String(tmpToken?.access_token || "").trim();
  const tmpRefreshToken = String(tmpToken?.refresh_token || "").trim();
  const tmpShopId = String(tmpToken?.shop_id || "").trim();
  const tokenSource = tmpAccessToken ? "tmp" : envAccessToken ? "env" : "none";
  const accessToken = tmpAccessToken || envAccessToken;
  const refreshToken = tmpAccessToken ? tmpRefreshToken : envRefreshToken;

  return res.status(200).json({
    has_access_token: Boolean(accessToken),
    has_refresh_token: Boolean(refreshToken),
    shop_id: (tmpAccessToken ? tmpShopId : envShopId) || null,
    token_length: accessToken ? accessToken.length : 0,
    token_source: tokenSource,
    callback_storage_seen: Boolean(tmpAccessToken)
  });
};

function readTmpToken() {
  try {
    if (!fs.existsSync(TMP_TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TMP_TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}
