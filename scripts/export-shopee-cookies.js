const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const COOKIE_PATH = path.join(__dirname, "..", "data", "shopee-cookies.json");
const PROFILE_PATH = path.join(__dirname, "..", "data", "shopee-browser-profile");

async function main() {
  const playwright = require("playwright");
  const executablePath = findWindowsBrowser();
  fs.mkdirSync(PROFILE_PATH, { recursive: true });

  const context = await playwright.chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    executablePath: executablePath || undefined,
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    viewport: { width: 1366, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto("https://shopee.co.id", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});

  console.log("Login Shopee di browser yang terbuka.");
  console.log(`Profil browser tersimpan di: ${PROFILE_PATH}`);
  console.log("Kalau muncul captcha, selesaikan dulu secara manual. Kalau sudah masuk dan halaman Shopee normal terbuka, tekan ENTER di terminal ini.");
  await waitForEnter();

  await page.goto("https://shopee.co.id", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const cookies = (await context.cookies())
    .filter((cookie) => /shopee\.co\.id|shopeemobile\.com/i.test(cookie.domain || ""));
  const hasUsefulSession = cookies.some((cookie) => /^SPC_|^csrftoken$|^REC_T_ID$/i.test(cookie.name || ""));
  if (!cookies.length || !hasUsefulSession) {
    console.error("Cookie Shopee belum terbaca. Login dulu sampai halaman Shopee terbuka sebagai akun Anda, lalu jalankan ulang npm run shopee:login.");
    console.error(`Jumlah cookie terbaca: ${cookies.length}`);
    await context.close();
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(COOKIE_PATH), { recursive: true });
  fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
  console.log(`Cookies tersimpan: ${COOKIE_PATH}`);
  console.log(`Jumlah cookies: ${cookies.length}`);
  console.log("Selanjutnya pencarian Shopee akan memakai cookie ini. Login ulang hanya diperlukan kalau cookie expired atau Shopee minta verifikasi ulang.");

  await context.close();
}

function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

function findWindowsBrowser() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
