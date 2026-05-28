const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const indexFile = path.join(publicDir, "index.html");

if (!fs.existsSync(indexFile)) {
  throw new Error("public/index.html tidak ditemukan. Vercel static build dibatalkan.");
}

console.log("Vercel build ready: static public/ + api/**/*.js serverless functions.");
