const { signAuthPartner } = require("../services/shopeeOpen");

const partnerId = String(process.env.SHOPEE_PARTNER_ID || process.env.SHOPEE_TEST_PARTNER_ID || "").trim();
const partnerKey = String(process.env.SHOPEE_PARTNER_KEY || process.env.SHOPEE_TEST_PARTNER_KEY || "").trim();
const timestamp = String(process.argv[2] || Math.floor(new Date().getTime() / 1000));

if (!partnerId || !partnerKey) {
  console.error("Isi SHOPEE_PARTNER_ID dan SHOPEE_PARTNER_KEY di .env sebelum test sign.");
  process.exit(1);
}

const result = signAuthPartner({ partnerId, partnerKey, timestamp });
console.log(JSON.stringify({
  path: "/api/v2/shop/auth_partner",
  timestamp,
  baseString: result.baseString,
  sign: result.sign,
  signLength: result.sign.length,
  partnerId,
  partnerKeyLength: partnerKey.length
}, null, 2));
