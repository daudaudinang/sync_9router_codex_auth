import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RunnerStateStore } from "../../src/services/codex-sync/runner/state-store.js";

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-state-"));
  store = new RunnerStateStore({
    stateFile: path.join(tmpDir, "codex-sync", "state.json"),
    syncIntervalSec: 300,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("codex-sync runner status", () => {
  it("defaults to stopped + currentRun null", () => {
    const state = store.loadState();
    expect(state.runnerState).toBe("runner_stopped");
    expect(state.currentRun).toBeNull();
  });

  it("supports in-progress currentRun object", () => {
    const state = store.update((s) => ({
      ...s,
      runnerState: "sync_in_progress",
      currentRun: {
        runId: "run-1",
        startedAt: new Date().toISOString(),
        trigger: "manual_sync_now",
        attempt: 1,
      },
    }));

    expect(state.runnerState).toBe("sync_in_progress");
    expect(state.currentRun.runId).toBe("run-1");
    expect(state.currentRun.attempt).toBe(1);
  });
});
