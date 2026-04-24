import { describe, it, expect } from "vitest";
import {
  nextRevisionForLocalMutation,
  shouldBumpRevision,
} from "../../src/services/codex-sync/core/revision-policy.js";

function record({ accessToken = "a", revision = 1, updatedAt = "x" } = {}) {
  return {
    email: "u@example.com",
    accessToken,
    refreshToken: "r",
    updatedAt,
    providerSpecificData: {
      accountId: "acct_1",
      inventoryKey: "email:u@example.com|acct:acct_1",
      inventoryRevision: revision,
      inventorySyncUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("codex-sync revision policy", () => {
  it("bumps when canonical payload changes", () => {
    const before = record({ accessToken: "a", revision: 7 });
    const after = record({ accessToken: "b", revision: 7 });
    expect(shouldBumpRevision(before, after)).toBe(true);
    expect(nextRevisionForLocalMutation(before, after)).toBe(8);
  });

  it("does not bump when only updatedAt changes", () => {
    const before = record({ updatedAt: "a", revision: 7 });
    const after = record({ updatedAt: "b", revision: 7 });
    expect(shouldBumpRevision(before, after)).toBe(false);
    expect(nextRevisionForLocalMutation(before, after)).toBe(7);
  });

  it("initializes to revision 1 when missing", () => {
    const before = record({ revision: null });
    const after = record({ revision: null });
    expect(nextRevisionForLocalMutation(before, after)).toBe(1);
  });
});
