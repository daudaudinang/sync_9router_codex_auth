import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseInventoryEnvelope,
  serializeInventoryEnvelope,
} from "../../src/services/codex-sync/remote/object-codec.js";
import { runSyncCycle } from "../../src/services/codex-sync/runner/sync-cycle.js";
import { LocalDbAdapter } from "../../src/services/codex-sync/local/db-adapter.js";
import { RunnerStateStore } from "../../src/services/codex-sync/runner/state-store.js";

function seedDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(
    dbPath,
    JSON.stringify(
      {
        providerConnections: [
          {
            provider: "codex",
            authType: "oauth",
            email: "user@example.com",
            accessToken: "a",
            refreshToken: "r",
            providerSpecificData: {
              accountId: "acct_1",
              inventoryKey: "email:user@example.com|acct:acct_1",
              inventoryRevision: 1,
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

describe("codex-sync encryption mode", () => {
  it("fails on decrypt with wrong key", () => {
    const body = serializeInventoryEnvelope([], {
      encryptionEnabled: true,
      sharedKey: "correct-key",
    });

    expect(() =>
      parseInventoryEnvelope(body, {
        sharedKey: "wrong-key",
      }),
    ).toThrow(/decrypt/i);
  });

  it("reports sync_error and keeps local DB untouched on decrypt fail", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-encryption-"));
    const dbPath = path.join(tmpDir, "db.json");
    const statePath = path.join(tmpDir, "codex-sync", "state.json");

    seedDb(dbPath);

    const adapter = new LocalDbAdapter({ dataDir: tmpDir, dbPath });
    const store = new RunnerStateStore({ stateFile: statePath, syncIntervalSec: 300 });

    const encryptedBody = serializeInventoryEnvelope([], {
      encryptionEnabled: true,
      sharedKey: "correct-key",
    });

    const remoteClient = {
      async getObject() {
        return {
          exists: true,
          etag: "etag-1",
          body: encryptedBody,
        };
      },
      async putObject() {
        return { etag: "etag-2" };
      },
    };

    const before = fs.readFileSync(dbPath, "utf8");

    const result = await runSyncCycle({
      config: {
        encryption: {
          enabled: true,
          sharedKey: "wrong-key",
        },
      },
      dbAdapter: adapter,
      stateStore: store,
      remoteClient,
      trigger: "manual_sync_now",
    });

    const after = fs.readFileSync(dbPath, "utf8");
    expect(result.outcome).toBe("sync_error");
    expect(after).toBe(before);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
