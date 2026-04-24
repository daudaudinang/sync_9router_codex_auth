import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { LocalDbAdapter } from "../../src/services/codex-sync/local/db-adapter.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runnerScriptPath = path.resolve(__dirname, "../../scripts/codex-sync-runner.js");

async function runRunner(command, env) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [runnerScriptPath, command, "--json"],
    {
      env: {
        ...process.env,
        ...env,
      },
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    },
  );

  return JSON.parse(stdout.trim());
}

describe("codex-sync contention", () => {
  it("serializes concurrent writers with lock + mutex", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-contention-"));
    const dbPath = path.join(tmpDir, "db.json");

    fs.writeFileSync(dbPath, JSON.stringify({ providerConnections: [], counter: 0 }, null, 2));

    const adapter = new LocalDbAdapter({ dataDir: tmpDir, dbPath });

    await Promise.all(
      Array.from({ length: 20 }).map(() =>
        adapter.writeDb((db) => {
          db.counter = (db.counter || 0) + 1;
          return db;
        }),
      ),
    );

    const db = await adapter.readDb();
    expect(db.counter).toBe(20);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prevents duplicate daemon writer on concurrent start", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-start-lock-"));
    const dbPath = path.join(tmpDir, "db.json");
    const remoteFilePath = path.join(tmpDir, "remote.json");
    fs.writeFileSync(dbPath, JSON.stringify({ providerConnections: [] }, null, 2));

    const env = {
      CODEX_SYNC_DATA_DIR: tmpDir,
      CODEX_SYNC_REMOTE_MODE: "file",
      CODEX_SYNC_REMOTE_FILE: remoteFilePath,
      CODEX_SYNC_INTERVAL_SEC: "3600",
      CODEX_SYNC_ACK_TIMEOUT_MS: "5000",
      CODEX_SYNC_POLL_INTERVAL_MS: "50",
    };

    try {
      await runRunner("stop", env);
      const [first, second] = await Promise.all([runRunner("start", env), runRunner("start", env)]);
      const codes = [first.code, second.code].sort();

      expect(codes).toEqual(["already_running", "started"]);

      const pidFile = path.join(tmpDir, "codex-sync", "runner.pid");
      expect(fs.existsSync(pidFile)).toBe(true);
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();

      const status = await runRunner("status", env);
      expect(status.runnerState).toBe("runner_running_idle");
      expect(status.service.pid).toBe(pid);
    } finally {
      try {
        await runRunner("stop", env);
      } catch {
        // ignore cleanup errors in test teardown
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
