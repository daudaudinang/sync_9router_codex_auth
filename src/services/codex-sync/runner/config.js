import path from "node:path";
import { getDefaultDataDir } from "../local/db-adapter.js";

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return fallback;
}

export function loadRunnerConfig() {
  const dataDir = process.env.CODEX_SYNC_DATA_DIR || getDefaultDataDir();
  const runtimeDir = path.join(dataDir, "codex-sync");
  const commandDir = path.join(runtimeDir, "commands");
  const stateFile = path.join(runtimeDir, "state.json");
  const pidFile = path.join(runtimeDir, "runner.pid");
  const startLockFile = path.join(runtimeDir, "start.lock");
  const writerLockFile = path.join(runtimeDir, "writer.lock");

  const syncIntervalSec = parseInteger(process.env.CODEX_SYNC_INTERVAL_SEC, 300);

  const config = {
    dataDir,
    dbPath: path.join(dataDir, "db.json"),
    runtimeDir,
    commandDir,
    stateFile,
    pidFile,
    startLockFile,
    writerLockFile,
    pollIntervalMs: parseInteger(process.env.CODEX_SYNC_POLL_INTERVAL_MS, 150),
    ackTimeoutMs: parseInteger(process.env.CODEX_SYNC_ACK_TIMEOUT_MS, 5000),
    syncIntervalSec,
    remote: {
      mode: (process.env.CODEX_SYNC_REMOTE_MODE || "file").toLowerCase(),
      objectKey: process.env.CODEX_SYNC_OBJECT_KEY || "inventory/codex-accounts.json",
      localFilePath:
        process.env.CODEX_SYNC_REMOTE_FILE ||
        path.join(runtimeDir, "remote", "codex-accounts.json"),
      endpoint: process.env.CODEX_SYNC_S3_ENDPOINT || "",
      bucket: process.env.CODEX_SYNC_S3_BUCKET || "",
      region: process.env.CODEX_SYNC_S3_REGION || "us-east-1",
      accessKeyId: process.env.CODEX_SYNC_S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.CODEX_SYNC_S3_SECRET_ACCESS_KEY || "",
      sessionToken: process.env.CODEX_SYNC_S3_SESSION_TOKEN || "",
      forcePathStyle: parseBoolean(process.env.CODEX_SYNC_S3_FORCE_PATH_STYLE, true),
    },
    encryption: {
      sharedKey: process.env.SYNC_SHARED_KEY || "",
      enabled: Boolean(process.env.SYNC_SHARED_KEY),
    },
  };

  return config;
}
