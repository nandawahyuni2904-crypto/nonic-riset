const fs = require("node:fs");
const path = require("node:path");

class JsonStore {
  constructor(filename, initialData = {}) {
    this.filePath = path.join(__dirname, "..", "data", filename);
    this.initialData = initialData;
    this.loaded = false;
    this.data = initialData;
  }

  read() {
    this.ensureLoaded();
    return this.data;
  }

  write(nextData) {
    this.data = nextData;
    this.loaded = true;
    if (isReadOnlyRuntime()) return this.data;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    return this.data;
  }

  update(mutator) {
    const current = this.read();
    const next = mutator(current) || current;
    return this.write(next);
  }

  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (isReadOnlyRuntime()) {
      this.data = this.initialData;
      return;
    }
    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = this.initialData;
        return;
      }
      this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch {
      this.data = this.initialData;
    }
  }
}

function isReadOnlyRuntime() {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

module.exports = {
  JsonStore
};
