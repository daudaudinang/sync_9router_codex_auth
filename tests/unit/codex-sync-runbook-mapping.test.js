import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { runSyncCycle } from "../../src/services/codex-sync/runner/sync-cycle.js";
import { LocalDbAdapter } from "../../src/services/codex-sync/local/db-adapter.js";
import { RunnerStateStore } from "../../src/services/codex-sync/runner/state-store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const RUNBOOK_PATH = path.resolve(__dirname, "../../docs/codex-sync-ops-checklist.md");

describe("codex-sync runbook mapping", () => {
  it("contains rejectReasons mapping", () => {
    const body = fs.readFileSync(RUNBOOK_PATH, "utf8");
    expect(body).toContain("missing_composite_identity");
    expect(body).toContain("missing_required_credentials");
    expect(body).toContain("missing_or_invalid_inventoryRevision");
    expect(body).toContain("inventory_key_mismatch");
    expect(body).toContain("invalid_record_shape");
  });

  it("contains error.category mapping", () => {
    const body = fs.readFileSync(RUNBOOK_PATH, "utf8");
    expect(body).toContain("remote_conflict");
    expect(body).toContain("remote_timeout");
    expect(body).toContain("remote_auth");
    expect(body).toContain("local_io");
    expect(body).toContain("validation");
    expect(body).toContain("unknown");
  });

  it("classifies auth failures as remote_auth", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-remote-auth-"));
    const dbPath = path.join(tmpDir, "db.json");
    const statePath = path.join(tmpDir, "codex-sync", "state.json");

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
              accessToken: "at",
              refreshToken: "rt",
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

    const adapter = new LocalDbAdapter({ dataDir: tmpDir, dbPath });
    const store = new RunnerStateStore({ stateFile: statePath, syncIntervalSec: 300 });

    const remoteClient = {
      async getObject() {
        const err = new Error("AccessDenied");
        err.code = "REMOTE_AUTH";
        err.statusCode = 403;
        throw err;
      },
      async putObject() {
        throw new Error("should-not-reach-put");
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
    });

    expect(result.outcome).toBe("sync_error");
    expect(result.lastRun.error.category).toBe("remote_auth");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
