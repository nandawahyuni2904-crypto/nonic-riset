export default function handler(req, res) {
  const { code, shop_id, main_account_id } = req.query;
  return res.status(200).json({
    ok: true,
    code: code || null,
    shop_id: shop_id || null,
    main_account_id: main_account_id || null
  });
}
