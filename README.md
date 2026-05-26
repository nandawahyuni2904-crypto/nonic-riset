# Product Trend Finder

Dashboard lokal untuk mencari peluang produk viral dari Video Viral Indonesia, lalu memvalidasi performanya dengan Shopee Open Platform AMS API.

## Fokus Utama

- Video Viral Indonesia dari YouTube Shorts sebagai sumber trend utama.
- Shopee Affiliate product performance dari Shopee Open Platform AMS API.
- Auto keyword extraction dari judul Shorts.
- Peluang viral dalam persen memakai cross-platform validation: trend Shorts, items sold, orders, clicks, ROI, dan new buyers.
- Mode `Auto Discover` untuk langsung mengambil Video Viral Indonesia tanpa keyword.
- Mode `Cari Manual` dan `Cari dari Kategori` untuk riset terarah.
- Satu endpoint research konsisten untuk Auto, Manual, dan Kategori.
- Fallback in-memory queue jika Redis belum aktif.

## Cara Jalan

1. Copy `.env.example` menjadi `.env`.
2. Isi `YOUTUBE_API_KEY`.
3. Install dependency:

```bash
npm install
```

4. Isi ENV Shopee AMS di `.env` jika ingin menampilkan Produk Affiliate.

5. Jalankan:

```bash
npm start
```

6. Buka `http://localhost:3000`.

Script deployment:

```bash
npm run dev
npm run start
npm run prod
```

Redis opsional. Jika `REDIS_URL` tidak tersedia atau Redis mati, aplikasi tetap berjalan memakai in-memory queue dan hanya menampilkan warning di terminal.

## Environment

```env
YOUTUBE_API_KEY=your_youtube_data_api_key
NODE_ENV=development
DEV_UNLIMITED=true
YOUTUBE_DAILY_QUOTA_UNITS=10000
QUOTA_SLOWDOWN_PERCENT=80
SHOPEE_PARTNER_ID=
SHOPEE_PARTNER_KEY=
SHOPEE_SHOP_ID=
SHOPEE_ACCESS_TOKEN=
SHOPEE_ENV=production
SHOPEE_SHOP_REGION=ID
SHOPEE_OPEN_BASE_URL=https://partner.shopeemobile.com
SHOPEE_AUTH_BASE_URL=https://partner.shopeemobile.com
SHOPEE_REDIRECT_URL=https://example.com
REDIS_URL=redis://127.0.0.1:6379
RESEARCH_CONCURRENCY=2
RESEARCH_RATE_LIMIT=8
RESULT_CACHE_TTL_MS=600000
SEARCH_CACHE_TTL_MS=1800000
DISCOVERY_KEYWORDS_PER_SEED=1
DISCOVERY_LIMIT_PER_KEYWORD=8
DAILY_SEARCH_LIMIT=5
ENABLE_EXPORT=true
ENABLE_DISCOVERY=true
MEMBER_API_TOKEN=
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=600
PORT=3000
```

## Endpoint Utama

```text
POST /api/research
GET /api/shorts-trending?keyword=alat%20dapur
GET /api/shorts-product-research?keyword=rak%20sepatu
GET /api/shopee-performance
GET /api/shopee/auth-url
GET /api/shopee/auth
GET /api/shopee/callback
GET /api/shopee/callback-debug
GET /api/shopee/status
GET /api/shopee/me
GET /api/shopee/ams-product-performance
GET /api/export/csv
GET /api/export/json
GET /api/trending/discover
GET /api/usage-status
GET /api/search-analytics
GET /api/health
GET /admin
GET /api/categories
GET /api/category-research?category=Gadget
```

Default parameter `GET /api/shopee-performance`:

- `period_type`: `Last30d`
- `order_type`: `ConfirmedOrder`
- `channel`: `AllChannel`
- `page_no`: `1`
- `page_size`: `20`

Test Shopee AMS:

```text
http://localhost:3000/api/shopee-performance
```

## Shopee Open Platform Sandbox

Integrasi sandbox memakai Test Partner ID dan Test API Partner Key dari `.env`.

1. Isi:

```env
SHOPEE_PARTNER_ID=your_test_partner_id
SHOPEE_PARTNER_KEY=your_test_api_partner_key
SHOPEE_SHOP_ID=your_test_shop_id
SHOPEE_OPEN_BASE_URL=https://partner.shopeemobile.com
SHOPEE_AUTH_BASE_URL=https://partner.shopeemobile.com
SHOPEE_REDIRECT_URL=https://example.com
```

2. Jalankan server, lalu buka:

```text
http://localhost:3000/api/shopee/auth-url
```

3. Copy `authUrl`, buka di browser, authorize toko sandbox Shopee.
4. Untuk sementara sandbox akan redirect ke `https://example.com`. Copy parameter `code` dan `shop_id` dari URL redirect tersebut, lalu buka manual:

```text
http://localhost:3000/api/shopee/callback?code=CODE_DARI_SHOPEE&shop_id=SHOP_ID_DARI_SHOPEE
```

Untuk deploy Vercel serverless, project ini bukan Next.js App Router atau Pages Router. Route OAuth dibuat di folder root `api/shopee/`:

```text
GET /api/shopee/auth
GET /api/shopee/callback
```

Callback Vercel saat ini mode test-only dan belum exchange token. Test setelah deploy:

```text
https://v0-nonic-riset.vercel.app/api/shopee/callback?code=test&shop_id=123
```

5. Callback lokal akan menukar `code` ke token, menyimpan token, lalu redirect ke `/` dengan pesan `Shopee connected successfully`.

```text
data/shopee-token.json
```

6. Cek status:

```text
http://localhost:3000/api/shopee/status
```

7. Test koneksi seller authenticated:

```text
http://localhost:3000/api/shopee/me
```

Endpoint ini tidak menampilkan `access_token` atau `refresh_token`.

8. Test endpoint AMS sandbox/production:

```text
http://localhost:3000/api/shopee/ams-product-performance
```

Default parameter endpoint AMS sandbox:

- `period_type`: `Last30d`
- `order_type`: `ConfirmedOrder`
- `channel`: `AllChannel`
- `page_no`: `1`
- `page_size`: `20`

Jika belum authorize, response akan menampilkan:

```text
Shopee belum authorized. Buka /api/shopee/auth-url
```

Catatan: ini hanya untuk sandbox/development. Jangan Go-Live dulu sebelum kredensial production dan redirect URL resmi siap.

Test wajib:

```bash
curl -X POST http://localhost:3000/api/research -H "Content-Type: application/json" -d "{\"mode\":\"manual\",\"keyword\":\"gadget viral\"}"
curl -X POST http://localhost:3000/api/research -H "Content-Type: application/json" -d "{\"mode\":\"category\",\"category\":\"Dapur\"}"
curl -X POST http://localhost:3000/api/research -H "Content-Type: application/json" -d "{\"mode\":\"category\",\"category\":\"Fashion Wanita\"}"
curl -X POST http://localhost:3000/api/research -H "Content-Type: application/json" -d "{\"mode\":\"category\",\"category\":\"Alat Rumah Tangga\"}"
```

Body `POST /api/research`:

```json
{
  "mode": "auto"
}
```

```json
{
  "mode": "manual",
  "keyword": "rak sepatu"
}
```

```json
{
  "mode": "category",
  "category": "Gadget"
}
```

Response berisi:

```json
{
  "mode": "auto",
  "keyword": "",
  "category": "",
  "shorts": [],
  "products": [],
  "opportunities": [],
  "message": "Auto Discover selesai"
}
```

## Trend Intelligence

Backend menambahkan layer trend intelligence di response research:

- `trendClusters`: grouping keyword mirip, typo ringan, dan parent keyword.
- `viral_hooks`: deteksi hook seperti `akhirnya`, `ternyata`, `viral`, `murah`, `shopee`, `tiktok`, `unboxing`, dan `review`.
- `commercial_intent` / `product_intent_score`: skor intent jualan 0-100.
- `analyticsSummary`: rata-rata views, rata-rata engagement, jam upload teratas, channel paling sering muncul, dan top product angle.

Export backend:

```text
GET /api/export/json
GET /api/export/csv
```

Opsional pakai query cache:

```text
GET /api/export/csv?mode=manual&keyword=gelas
GET /api/export/json?mode=category&category=Dapur
```

Cache search result disimpan 30 menit (`SEARCH_CACHE_TTL_MS=1800000`) untuk mengurangi penggunaan quota YouTube.

## Automatic Viral Product Discovery

Endpoint:

```text
GET /api/trending/discover
```

Engine discovery otomatis scan seed ringan:

```text
gadget, dapur, rumah, kecantikan, fashion, bayi, kesehatan, otomotif
```

Setiap seed diperluas ke sub-keyword seperti `rak sepatu`, `lampu sensor`, `gelas portable`, `organizer dapur`, dan `skincare viral`. Untuk hemat quota, default hanya 1 keyword terbaik per seed dan hasil disimpan ke `data/discovery-cache.json` selama 24 jam. Pakai `?refresh=1` hanya jika benar-benar ingin refresh manual.

Output utama:

- `emergingProducts`
- `momentum_score`
- `lifecycle`: `EARLY`, `RISING`, `HOT`, `SATURATED`
- `top_hook`
- `avg_views`
- `confidence`

## Production Hardening

- Guest mode otomatis aktif dengan limit `DAILY_SEARCH_LIMIT=5` search per hari.
- Development bypass aktif jika `NODE_ENV=development` atau `DEV_UNLIMITED=true` dan request berasal dari localhost. Dalam mode ini guest limiter, export toggle, dan discovery toggle dilewati.
- Member mode siap dipakai dengan header:

```text
X-Member-Token: isi_sama_dengan_MEMBER_API_TOKEN
```

- Export bisa dimatikan dengan `ENABLE_EXPORT=false`.
- Discovery bisa dimatikan dengan `ENABLE_DISCOVERY=false`.
- Quota protection memakai `YOUTUBE_DAILY_QUOTA_UNITS` dan `QUOTA_SLOWDOWN_PERCENT`; saat mendekati limit, auto discovery/manual cache fallback diprioritaskan.
- Search analytics disimpan ke `data/analytics.json`.
- Usage limiter disimpan ke `data/usage.json`.
- Storage memakai abstraksi JSON store agar nanti mudah diganti ke Supabase/Postgres.

## Production Deployment

- Environment dipisah lewat `NODE_ENV=development` atau `NODE_ENV=production`.
- Startup akan memberi warning jika ENV penting hilang.
- Healthcheck tersedia di:

```text
GET /api/health
```

Healthcheck berisi uptime server, status YouTube API, cache, quota, usage, dan Shopee auth.

- Admin dashboard ringan tersedia di:

```text
GET /admin
```

- Request log, error log, dan quota warning log disimpan ke `data/logs/`.
- File storage otomatis disiapkan:
  - `data/analytics.json`
  - `data/cache.json`
  - `data/users.json`
  - `data/searches.json`
- Cache autosave setiap 5 menit dan disimpan saat shutdown (`SIGINT`/`SIGTERM`).
- Security basics aktif tanpa dependency berat: security headers, rate limiting, dan sanitasi query input.

## Alur Riset

```text
Video Viral Indonesia
-> ekstrak keyword produk dari title
-> ambil performa produk Affiliate dari Shopee AMS API
-> pilih top 5 produk Affiliate terbaik berdasarkan items sold, orders, clicks, ROI, dan new buyers
-> cocokkan produk Affiliate terbaik dengan Shorts
-> hitung peluang viral cross-platform
```

Jika Shopee AMS API belum dikonfigurasi, section `Peluang Viral` tetap diisi dari sinyal Shorts dengan catatan `Menunggu validasi marketplace`, dan UI menampilkan `Shopee AMS API belum dikonfigurasi.`

Bobot peluang viral:

- `Shorts views/trend`: 40%
- `Produk Affiliate`: 60%, dihitung dari `items_sold`, `orders`, `clicks`, `roi`, dan `new_buyers`

Label peluang:

- `HOT`
- `POTENSIAL`
- `MENARIK`
- `LOW`

## Catatan Shopee AMS

YouTube memakai YouTube Data API `search.list` dengan `regionCode=ID`, `relevanceLanguage=id`, `hl=id`, `type=video`, dan `maxResults=25`. Engine hanya menerima video dengan URL `/shorts/`, durasi di bawah 90 detik, dan title yang lolos filter spam/navigation. Jika hasil kurang dari 20, sistem otomatis mencari fallback keyword seperti `viral`, `aesthetic`, `unik`, `shopee`, `tiktok shop`, `kekinian`, `racun`, dan `rekomendasi`.

Finder ini sengaja fokus ke produk jualan. Video dengan intent produk seperti `viral`, `shopee`, `tiktok shop`, `racun`, `beli`, `murah`, `review`, `unboxing`, `rekomendasi`, `aesthetic`, `multifungsi`, dan `portable` akan diprioritaskan lewat `product_confidence`. Konten random seperti `prank`, `lucu`, `meme`, `ngakak`, `eksperimen`, `challenge`, `rusak`, `air panas`, dan `siram` akan turun jauh dari ranking.

Integrasi Shopee memakai Shopee Open Platform endpoint `v2.ams.get_product_performance` melalui path `/api/v2/ams/get_product_performance`. Signature dibuat mengikuti pola Open Platform v2: `partner_id + path + timestamp + access_token + shop_id`, lalu HMAC SHA256 memakai `SHOPEE_PARTNER_KEY`.
