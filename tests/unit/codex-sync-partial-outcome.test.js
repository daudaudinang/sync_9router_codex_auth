import { describe, it, expect } from "vitest";
import { classifyRunOutcome } from "../../src/services/codex-sync/runner/run-summary.js";

describe("codex-sync partial outcome classification", () => {
  it("classifies local committed + remote failed as sync_partial", () => {
    const r = classifyRunOutcome({
      localCommitted: true,
      remoteCommitted: false,
      remoteAttempted: true,
      errorCategory: "remote_timeout",
    });

    expect(r.outcome).toBe("sync_partial");
    expect(r.category).toBe("remote_timeout");
  });

  it("classifies local failed as sync_error", () => {
    const r = classifyRunOutcome({
      localCommitted: false,
      remoteCommitted: false,
      remoteAttempted: false,
      errorCategory: "local_io",
    });

    expect(r.outcome).toBe("sync_error");
  });

  it("classifies success when both phases committed", () => {
    const r = classifyRunOutcome({
      localCommitted: true,
      remoteCommitted: true,
      remoteAttempted: true,
      errorCategory: "none",
    });

    expect(r.outcome).toBe("sync_success");
  });
});
