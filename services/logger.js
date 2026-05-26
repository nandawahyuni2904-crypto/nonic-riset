const fs = require("node:fs");
const path = require("node:path");

const LOG_DIR = path.join(__dirname, "..", "data", "logs");

function requestLog(req, status, durationMs) {
  const line = `${req.method} ${req.url} ${status} ${durationMs}ms`;
  console.log(`[request] ${line}`);
  append("requests.log", line);
}

function errorLog(error, context = "") {
  const line = `${context} ${error?.stack || error?.message || error}`;
  console.error(`[error] ${line}`);
  append("errors.log", line);
}

function quotaWarn(message, data = {}) {
  const line = `${message} ${JSON.stringify(data)}`;
  console.warn(`[quota] ${line}`);
  append("quota.log", line);
}

function shopeeApiLog(message, data = {}) {
  const line = `${message} ${JSON.stringify(data)}`;
  console.log(`[shopee] ${line}`);
  append("shopee.log", line);
}

function startupWarn(message) {
  console.warn(`[startup] ${message}`);
  append("startup.log", message);
}

function append(filename, line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, filename), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // Logging must never crash the app.
  }
}

module.exports = {
  errorLog,
  quotaWarn,
  requestLog,
  shopeeApiLog,
  startupWarn
};
