const LAST_RESULT_COOKIE = "SHOPEE_CALLBACK_LAST_RESULT";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "no-store");

  const cookies = parseCookies(req);
  const result = parseLastResult(cookies[LAST_RESULT_COOKIE]);

  if (result) {
    return res.status(200).json(result);
  }

  return res.status(200).json({
    callback_executed: false,
    access_token_received: false,
    refresh_token_received: false,
    shop_id_received: false,
    save_attempted: false,
    save_success: false,
    save_location: null,
    save_error: "No callback result cookie found. The callback may not have run in this browser session, Set-Cookie may be blocked, or the debug cookie expired."
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

function parseLastResult(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    return {
      callback_executed: false,
      access_token_received: false,
      refresh_token_received: false,
      shop_id_received: false,
      save_attempted: false,
      save_success: false,
      save_location: null,
      save_error: `Invalid callback result cookie: ${error.message}`
    };
  }
}
