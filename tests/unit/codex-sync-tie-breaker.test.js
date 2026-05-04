import { describe, it, expect } from "vitest";
import { resolveEqualRevisionConflict } from "../../src/services/codex-sync/core/tie-breaker.js";

function makeRecord(accessToken, updatedAt = "2026-01-01T00:00:00.000Z") {
  return {
    email: "u@example.com",
    accessToken,
    refreshToken: "rt",
    updatedAt,
    providerSpecificData: {
      accountId: "acct_1",
      inventoryKey: "email:u@example.com|acct:acct_1",
      inventoryRevision: 3,
      inventorySyncUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("codex-sync equal revision tie breaker", () => {
  it("returns unchanged when payload equal", () => {
    const r = resolveEqualRevisionConflict(makeRecord("a"), makeRecord("a"));
    expect(r.changed).toBe(false);
  });

  it("picks local when updatedAt is newer on local", () => {
    const r = resolveEqualRevisionConflict(
      makeRecord("aaa", "2026-02-02T00:00:00.000Z"),
      makeRecord("bbb", "2026-02-01T00:00:00.000Z"),
    );
    expect(r.changed).toBe(true);
    expect(r.winner).toBe("local");
  });

  it("picks remote when updatedAt is newer on remote", () => {
    const r = resolveEqualRevisionConflict(
      makeRecord("aaa", "2026-02-01T00:00:00.000Z"),
      makeRecord("bbb", "2026-02-02T00:00:00.000Z"),
    );
    expect(r.changed).toBe(true);
    expect(r.winner).toBe("remote");
  });

  it("deterministic digest fallback when updatedAt ties", () => {
    const first = resolveEqualRevisionConflict(
      makeRecord("aaa", "2026-01-01T00:00:00.000Z"),
      makeRecord("bbb", "2026-01-01T00:00:00.000Z"),
    );
    const second = resolveEqualRevisionConflict(
      makeRecord("aaa", "2026-01-01T00:00:00.000Z"),
      makeRecord("bbb", "2026-01-01T00:00:00.000Z"),
    );

    expect(first.changed).toBe(true);
    expect(first.winner).toBe(second.winner);
  });
});
