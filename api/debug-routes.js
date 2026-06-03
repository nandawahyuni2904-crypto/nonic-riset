const ROUTES = [
  "/api/shopee/status",
  "/api/shopee/ams-test",
  "/api/shopee/affiliate-status",
  "/api/shopee/current-env",
  "/api/shopee/affiliate-probe"
];

module.exports = function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  return res.status(200).json({
    ok: true,
    routes: ROUTES,
    target: "/api/shopee/affiliate-probe?keyword=gelas"
  });
};
