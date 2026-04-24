import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { runSyncCycle } from "../../src/services/codex-sync/runner/sync-cycle.js";
import { LocalDbAdapter } from "../../src/services/codex-sync/local/db-adapter.js";
import { RunnerStateStore } from "../../src/services/codex-sync/runner/state-store.js";
import { S3InventoryClient } from "../../src/services/codex-sync/remote/s3-client.js";

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
              inventoryRevision: 2,
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

describe("codex-sync conflict loop", () => {
  it("retries on remote conflict and converges", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-conflict-"));
    const dbPath = path.join(tmpDir, "db.json");
    const statePath = path.join(tmpDir, "codex-sync", "state.json");

    seedDb(dbPath);

    const adapter = new LocalDbAdapter({ dataDir: tmpDir, dbPath });
    const store = new RunnerStateStore({ stateFile: statePath, syncIntervalSec: 300 });

    let putAttempts = 0;
    const remoteClient = {
      async getObject() {
        return {
          exists: true,
          etag: "etag-1",
          body: JSON.stringify({
            schemaVersion: 3,
            inventoryType: "9router-codex-account-token-inventory",
            generatedAt: new Date().toISOString(),
            records: [],
          }),
        };
      },
      async putObject() {
        putAttempts += 1;
        if (putAttempts === 1) {
          const err = new Error("etag mismatch");
          err.code = "REMOTE_CONFLICT";
          throw err;
        }
        return { etag: "etag-2" };
      },
    };

    const result = await runSyncCycle({
      config: {
        encryption: { enabled: false, sharedKey: "" },
      },
      dbAdapter: adapter,
      stateStore: store,
      remoteClient,
      trigger: "manual_sync_now",
      maxConflictRetries: 2,
    });

    expect(putAttempts).toBe(2);
    expect(result.outcome).toBe("sync_success");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("s3 conditional put atomicity", () => {
  it("sends If-Match and maps 412 to REMOTE_CONFLICT", async () => {
    const originalFetch = global.fetch;
    let capturedHeaders = null;

    global.fetch = async (_url, options) => {
      capturedHeaders = options?.headers || null;
      return new Response("precondition failed", { status: 412 });
    };

    try {
      const client = new S3InventoryClient({
        mode: "minio",
        endpoint: "http://127.0.0.1:19000",
        bucket: "codex-sync",
        objectKey: "inventory/codex-accounts.json",
        region: "us-east-1",
        accessKeyId: "minio",
        secretAccessKey: "minio123",
        forcePathStyle: true,
      });

      await expect(
        client.putObject({
          body: '{"ok":true}',
          expectedEtag: "abc123etag",
        }),
      ).rejects.toMatchObject({
        code: "REMOTE_CONFLICT",
      });

      expect(capturedHeaders["if-match"]).toBe("\"abc123etag\"");
      expect(capturedHeaders["if-none-match"]).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("uses If-None-Match=* for create-if-absent when expectedEtag is missing", async () => {
    const originalFetch = global.fetch;
    let capturedHeaders = null;

    global.fetch = async (_url, options) => {
      capturedHeaders = options?.headers || null;
      return new Response("precondition failed", { status: 412 });
    };

    try {
      const client = new S3InventoryClient({
        mode: "s3",
        endpoint: "http://127.0.0.1:19000",
        bucket: "codex-sync",
        objectKey: "inventory/codex-accounts.json",
        region: "us-east-1",
        accessKeyId: "minio",
        secretAccessKey: "minio123",
        forcePathStyle: true,
      });

      await expect(
        client.putObject({
          body: '{"ok":true}',
          expectedEtag: null,
          expectedExists: false,
        }),
      ).rejects.toMatchObject({
        code: "REMOTE_CONFLICT",
      });

      expect(capturedHeaders["if-none-match"]).toBe("*");
      expect(capturedHeaders["if-match"]).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("rejects non-atomic update when remote exists but expected etag is missing", async () => {
    const originalFetch = global.fetch;
    let fetchCalled = false;

    global.fetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };

    try {
      const client = new S3InventoryClient({
        mode: "s3",
        endpoint: "http://127.0.0.1:19000",
        bucket: "codex-sync",
        objectKey: "inventory/codex-accounts.json",
        region: "us-east-1",
        accessKeyId: "minio",
        secretAccessKey: "minio123",
        forcePathStyle: true,
      });

      await expect(
        client.putObject({
          body: '{"ok":true}',
          expectedEtag: null,
          expectedExists: true,
        }),
      ).rejects.toMatchObject({
        code: "REMOTE_CONFLICT",
      });

      expect(fetchCalled).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
