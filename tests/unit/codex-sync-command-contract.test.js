import { describe, it, expect } from "vitest";
import { buildCommandResponse } from "../../src/services/codex-sync/runner/command-handler.js";

describe("codex-sync command contract", () => {
  it("omits result.syncNow for start", () => {
    const payload = buildCommandResponse({
      status: "success",
      command: "start",
      code: "started",
      requestId: "req-1",
      runnerStateAfter: "runner_running_idle",
    });

    expect(payload.status).toBe("success");
    expect(payload.code).toBe("started");
    expect(payload.message).toBe("Runner started.");
    expect(payload.result.requestId).toBe("req-1");
    expect(payload.result.syncNow).toBeUndefined();
  });

  it("includes result.syncNow for sync-now", () => {
    const payload = buildCommandResponse({
      status: "success",
      command: "sync-now",
      code: "sync_enqueued",
      requestId: "req-2",
      runnerStateAfter: "runner_running_idle",
      syncNow: {
        enqueued: true,
        deduplicated: false,
      },
    });

    expect(payload.message).toBe("Sync request enqueued.");
    expect(payload.result.syncNow).toEqual({ enqueued: true, deduplicated: false });
  });

  it("maps deterministic reject message", () => {
    const payload = buildCommandResponse({
      status: "rejected",
      command: "sync-now",
      code: "runner_not_running",
      requestId: "req-3",
      runnerStateAfter: "runner_stopped",
      syncNow: {
        enqueued: false,
        deduplicated: false,
      },
    });

    expect(payload.message).toBe("Runner is not running.");
  });

  it("returns explicit unknown-command message", () => {
    const payload = buildCommandResponse({
      status: "rejected",
      command: "foobar",
      code: "unknown_command",
      requestId: "req-unknown",
      runnerStateAfter: "runner_stopped",
    });

    expect(payload.command).toBe("foobar");
    expect(payload.code).toBe("unknown_command");
    expect(payload.message).toBe(
      "Unknown command. Supported commands: start, stop, status, sync-now.",
    );
    expect(payload.result.syncNow).toBeUndefined();
  });
});
