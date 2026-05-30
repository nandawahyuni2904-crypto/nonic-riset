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
  const cookies = parseCookies(req);
  const envAccessToken = String(process.env.SHOPEE_ACCESS_TOKEN || "").trim();
  const envRefreshToken = String(process.env.SHOPEE_REFRESH_TOKEN || "").trim();
  const envShopId = String(process.env.SHOPEE_SHOP_ID || "").trim();
  const tmpAccessToken = String(tmpToken?.access_token || "").trim();
  const tmpRefreshToken = String(tmpToken?.refresh_token || "").trim();
  const tmpShopId = String(tmpToken?.shop_id || "").trim();
  const cookieAccessToken = String(cookies.SHOPEE_ACCESS_TOKEN || "").trim();
  const cookieRefreshToken = String(cookies.SHOPEE_REFRESH_TOKEN || "").trim();
  const cookieShopId = String(cookies.SHOPEE_SHOP_ID || "").trim();
  const tokenSource = tmpAccessToken ? "tmp" : cookieAccessToken ? "cookie" : envAccessToken ? "env" : "none";
  const accessToken = tmpAccessToken || cookieAccessToken || envAccessToken;
  const refreshToken = tmpAccessToken ? tmpRefreshToken : cookieAccessToken ? cookieRefreshToken : envRefreshToken;

  return res.status(200).json({
    has_access_token: Boolean(accessToken),
    has_refresh_token: Boolean(refreshToken),
    shop_id: (tmpAccessToken ? tmpShopId : cookieAccessToken ? cookieShopId : envShopId) || null,
    token_length: accessToken ? accessToken.length : 0,
    token_source: tokenSource,
    callback_storage_seen: Boolean(tmpAccessToken || cookieAccessToken)
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
