const CATEGORY_KEYWORDS = {
  "Alat Rumah Tangga": [
    "alat rumah tangga",
    "alat pembersih",
    "perlengkapan rumah",
    "rak rumah",
    "dekorasi rumah"
  ],
  "Dapur": [
    "alat dapur",
    "perlengkapan dapur",
    "alat masak",
    "rak dapur",
    "pisau dapur"
  ],
  "Fashion Wanita": [
    "fashion wanita",
    "outfit wanita",
    "baju wanita",
    "dress wanita",
    "celana wanita"
  ],
  "Fashion Pria": [
    "fashion pria",
    "outfit pria",
    "celana pria",
    "sepatu pria",
    "kaos pria"
  ],
  "Gadget": [
    "gadget",
    "aksesoris gadget",
    "alat elektronik",
    "gadget unik",
    "tech gadget"
  ],
  "Aksesoris HP": [
    "aksesoris hp viral",
    "case hp unik",
    "stand hp viral",
    "charger murah bagus",
    "holder hp mobil"
  ],
  "Baby & Kids": [
    "perlengkapan bayi viral",
    "produk anak terlaris",
    "mainan edukasi anak",
    "alat makan bayi",
    "baby gear murah"
  ],
  "Otomotif": [
    "aksesoris mobil viral",
    "aksesoris motor viral",
    "produk otomotif murah",
    "alat cuci mobil",
    "gadget motor unik"
  ],
  "Kesehatan": [
    "alat kesehatan viral",
    "produk kesehatan rumah",
    "alat pijat viral",
    "perlengkapan olahraga ringan",
    "produk wellness murah"
  ],
  "Olahraga": [
    "alat olahraga rumah",
    "fitness equipment murah",
    "perlengkapan gym viral",
    "alat olahraga portable",
    "produk olahraga terlaris"
  ],
  "Pet Shop": [
    "produk kucing viral",
    "produk anjing viral",
    "pet supplies murah",
    "mainan kucing viral",
    "alat grooming hewan"
  ],
  "Dekorasi Rumah": [
    "dekorasi rumah viral",
    "home decor murah",
    "lampu dekorasi aesthetic",
    "hiasan kamar viral",
    "rak rumah minimalis"
  ],
  "Travel": [
    "travel gear viral",
    "perlengkapan travel murah",
    "tas travel compact",
    "alat packing koper",
    "produk liburan praktis"
  ],
  "Elektronik Murah": [
    "elektronik murah viral",
    "alat elektronik rumah",
    "lampu led murah",
    "mini appliance viral",
    "barang elektronik unik"
  ],
  "Peralatan Sekolah": [
    "alat sekolah viral",
    "stationery unik",
    "tas sekolah murah",
    "perlengkapan belajar",
    "alat tulis aesthetic"
  ],
  "Peralatan Kantor": [
    "alat kantor viral",
    "desk setup murah",
    "office gadget viral",
    "perlengkapan meja kerja",
    "organizer kantor"
  ],
  "Mainan Anak": [
    "mainan anak viral",
    "mainan edukasi murah",
    "toys viral indonesia",
    "mainan balita terlaris",
    "mainan kreatif anak"
  ],
  "Perlengkapan Ibadah": [
    "perlengkapan ibadah viral",
    "sajadah travel",
    "mukena travel murah",
    "tasbih digital",
    "alat ibadah praktis"
  ],
  "Aksesoris Wanita": [
    "aksesoris wanita viral",
    "jepit rambut viral",
    "kalung wanita murah",
    "gelang wanita aesthetic",
    "aksesoris hijab viral"
  ],
  "Tas & Dompet": [
    "tas viral",
    "dompet wanita viral",
    "tas pria murah",
    "sling bag terlaris",
    "dompet minimalis"
  ]
};

function getCategories() {
  return Object.keys(CATEGORY_KEYWORDS);
}

function getCategoryKeywords(category) {
  return CATEGORY_KEYWORDS[category] || [];
}

module.exports = {
  CATEGORY_KEYWORDS,
  getCategories,
  getCategoryKeywords
};
