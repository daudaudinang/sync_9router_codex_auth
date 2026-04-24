import { describe, it, expect } from "vitest";
import { resolveEqualRevisionConflict } from "../../src/services/codex-sync/core/tie-breaker.js";

function makeRecord(accessToken) {
  return {
    email: "u@example.com",
    accessToken,
    refreshToken: "rt",
    providerSpecificData: {
      accountId: "acct_1",
      inventoryKey: "email:u@example.com|acct:acct_1",
      inventoryRevision: 3,
    },
  };
}

describe("codex-sync equal revision tie breaker", () => {
  it("returns unchanged when payload equal", () => {
    const r = resolveEqualRevisionConflict(makeRecord("a"), makeRecord("a"));
    expect(r.changed).toBe(false);
  });

  it("deterministically chooses same winner", () => {
    const first = resolveEqualRevisionConflict(makeRecord("aaa"), makeRecord("bbb"));
    const second = resolveEqualRevisionConflict(makeRecord("aaa"), makeRecord("bbb"));

    expect(first.changed).toBe(true);
    expect(first.winner).toBe(second.winner);
  });
});
