import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_OPTIONS = {
  retries: {
    retries: 15,
    minTimeout: 50,
    maxTimeout: 3000,
  },
  stale: 10000,
};

class LocalMutex {
  constructor() {
    this.queue = [];
    this.locked = false;
  }

  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise((resolve) => this.queue.push(resolve)).then(
      () => () => this.release(),
    );
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}

const processMutex = new LocalMutex();

function defaultDbShape() {
  return {
    providerConnections: [],
    providerNodes: [],
    proxyPools: [],
    modelAliases: {},
    mitmAlias: {},
    combos: [],
    apiKeys: [],
    settings: {},
    pricing: {},
  };
}

export function getDefaultDataDir() {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }
  return path.join(os.homedir(), ".9router");
}

function safeJsonParse(raw, fallbackValue) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function ensureDbFile(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultDbShape(), null, 2));
  }
}

function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export class LocalDbAdapter {
  constructor(options = {}) {
    const dataDir = options.dataDir || getDefaultDataDir();
    this.dataDir = dataDir;
    this.dbPath = options.dbPath || path.join(dataDir, "db.json");
  }

  async withLockedDb(mutator, options = {}) {
    const write = options.write !== false;

    ensureDbFile(this.dbPath);

    const releaseMutex = await processMutex.acquire();
    let releaseFileLock = null;

    try {
      releaseFileLock = await lockfile.lock(this.dbPath, LOCK_OPTIONS);
      const raw = fs.readFileSync(this.dbPath, "utf-8");
      const current = safeJsonParse(raw, defaultDbShape());
      const next = (await mutator(current)) || current;

      if (write) {
        atomicWriteJson(this.dbPath, next);
      }

      return next;
    } finally {
      if (releaseFileLock) {
        try {
          await releaseFileLock();
        } catch {
          // Ignore unlock failures.
        }
      }
      releaseMutex();
    }
  }

  async readDb() {
    return this.withLockedDb((db) => db, { write: false });
  }

  async writeDb(mutator) {
    return this.withLockedDb(mutator, { write: true });
  }

  getScopedConnections(db) {
    const providerConnections = Array.isArray(db?.providerConnections)
      ? db.providerConnections
      : [];
    return providerConnections.filter(
      (record) => record?.provider === "codex" && record?.authType === "oauth",
    );
  }
}
