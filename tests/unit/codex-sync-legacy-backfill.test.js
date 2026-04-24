import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalDbAdapter } from "../../src/services/codex-sync/local/db-adapter.js";
import { RunnerStateStore } from "../../src/services/codex-sync/runner/state-store.js";
import { runLegacyBackfill } from "../../src/services/codex-sync/core/legacy-backfill.js";

let tmpDir;
let adapter;
let store;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe("codex-sync legacy backfill", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-backfill-"));
    const dbPath = path.join(tmpDir, "db.json");
    const statePath = path.join(tmpDir, "codex-sync", "state.json");

    writeJson(dbPath, {
      providerConnections: [
        {
          provider: "codex",
          authType: "oauth",
          email: "User@Example.com",
          accessToken: "at",
          refreshToken: "rt",
          providerSpecificData: {
            accountId: "acct_1",
          },
        },
      ],
    });

    adapter = new LocalDbAdapter({ dataDir: tmpDir, dbPath });
    store = new RunnerStateStore({ stateFile: statePath, syncIntervalSec: 300 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("patches missing inventory metadata deterministically", async () => {
    const first = await runLegacyBackfill({ dbAdapter: adapter, stateStore: store });
    expect(first.summary.scanned).toBe(1);
    expect(first.summary.patched).toBe(1);

    const db = await adapter.readDb();
    const record = db.providerConnections[0];
    expect(record.providerSpecificData.inventoryKey).toBe("email:user@example.com|acct:acct_1");
    expect(record.providerSpecificData.inventoryRevision).toBe(1);
    expect(record.providerSpecificData.inventorySyncUpdatedAt).toBeTruthy();
  });

  it("is idempotent on re-run", async () => {
    await runLegacyBackfill({ dbAdapter: adapter, stateStore: store });
    const second = await runLegacyBackfill({ dbAdapter: adapter, stateStore: store });
    expect(second.changed).toBe(false);
    expect(second.summary.patched).toBe(0);
  });

  it("backfills newly imported records after the first run", async () => {
    await runLegacyBackfill({ dbAdapter: adapter, stateStore: store });

    await adapter.writeDb((db) => {
      db.providerConnections.push({
        provider: "codex",
        authType: "oauth",
        email: "new-user@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
        providerSpecificData: {
          accountId: "acct_2",
        },
      });
      return db;
    });

    const rerun = await runLegacyBackfill({ dbAdapter: adapter, stateStore: store });
    expect(rerun.changed).toBe(true);
    expect(rerun.summary.patched).toBe(1);

    const db = await adapter.readDb();
    const record = db.providerConnections.find(
      (item) => item.providerSpecificData?.accountId === "acct_2",
    );
    expect(record.providerSpecificData.inventoryKey).toBe("email:new-user@example.com|acct:acct_2");
    expect(record.providerSpecificData.inventoryRevision).toBe(1);
  });
});
