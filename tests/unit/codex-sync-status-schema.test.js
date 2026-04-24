import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { RunnerStateStore } from "../../src/services/codex-sync/runner/state-store.js";

function makeStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-schema-"));
  const store = new RunnerStateStore({
    stateFile: path.join(tmpDir, "codex-sync", "state.json"),
    syncIntervalSec: 123,
  });
  return { tmpDir, store };
}

describe("codex-sync status schema", () => {
  it("has mandatory rejectReasons keys with zero defaults", () => {
    const { tmpDir, store } = makeStore();
    const state = store.loadState();

    expect(state.lastRun.rejectReasons).toEqual({
      missing_composite_identity: 0,
      missing_required_credentials: 0,
      missing_or_invalid_inventoryRevision: 0,
      inventory_key_mismatch: 0,
      invalid_record_shape: 0,
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists lastRun across reload", () => {
    const { tmpDir, store } = makeStore();

    store.update((state) => ({
      ...state,
      lastRun: {
        ...state.lastRun,
        runId: "run-abc",
        outcome: "sync_success",
      },
    }));

    const reloaded = store.loadState();
    expect(reloaded.lastRun.runId).toBe("run-abc");
    expect(reloaded.lastRun.outcome).toBe("sync_success");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
