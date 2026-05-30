module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const cookies = parseCookies(req);
  const envAccessToken = String(process.env.SHOPEE_ACCESS_TOKEN || "").trim();
  const cookieAccessToken = String(cookies.SHOPEE_ACCESS_TOKEN || "").trim();
  const envRefreshToken = String(process.env.SHOPEE_REFRESH_TOKEN || "").trim();
  const cookieRefreshToken = String(cookies.SHOPEE_REFRESH_TOKEN || "").trim();
  const envShopId = String(process.env.SHOPEE_SHOP_ID || "").trim();
  const cookieShopId = String(cookies.SHOPEE_SHOP_ID || "").trim();
  const accessToken = cookieAccessToken || envAccessToken;
  const refreshToken = cookieRefreshToken || envRefreshToken;

  return res.status(200).json({
    has_access_token: Boolean(accessToken),
    has_refresh_token: Boolean(refreshToken),
    shop_id: cookieShopId || envShopId || null,
    token_length: accessToken ? accessToken.length : 0,
    token_source: cookieAccessToken ? "cookie" : envAccessToken ? "env" : "none"
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
