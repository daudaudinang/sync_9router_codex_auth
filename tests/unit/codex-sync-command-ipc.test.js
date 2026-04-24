import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  createCommandAck,
  createCommandRequest,
  consumeRequest,
  listPendingRequests,
  waitForAck,
} from "../../src/services/codex-sync/runner/command-transport.js";

let tmpDir;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe("codex-sync command IPC", () => {
  it("writes request and consumes request atomically", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-ipc-"));
    const payload = { requestId: "req-1", command: "sync-now" };

    createCommandRequest(tmpDir, payload);
    const list = listPendingRequests(tmpDir);
    expect(list).toEqual(["req-1.json"]);

    const consumed = consumeRequest(tmpDir, "req-1.json");
    expect(consumed).toEqual(payload);
    expect(listPendingRequests(tmpDir)).toEqual([]);
  });

  it("waits for ack lifecycle", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sync-ipc-"));

    setTimeout(() => {
      createCommandAck(tmpDir, {
        status: "success",
        command: "sync-now",
        code: "sync_enqueued",
        message: "Sync request enqueued.",
        result: {
          requestId: "req-ack",
          runnerStateAfter: "runner_running_idle",
          effectiveAt: new Date().toISOString(),
          syncNow: { enqueued: true, deduplicated: false },
        },
      });
    }, 30);

    const ack = await waitForAck(tmpDir, "req-ack", {
      timeoutMs: 1000,
      pollIntervalMs: 10,
    });

    expect(ack.code).toBe("sync_enqueued");
  });
});
