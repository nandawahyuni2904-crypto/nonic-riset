const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.join(__dirname, "..", "data");
const FILES = {
  "analytics.json": { searches: {}, momentum: {}, niches: {}, events: [] },
  "cache.json": { updatedAt: new Date().toISOString(), entries: {} },
  "users.json": { users: [] },
  "searches.json": { searches: [] }
};

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  Object.entries(FILES).forEach(([filename, initial]) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    }
  });
}

module.exports = {
  ensureStorage
};
