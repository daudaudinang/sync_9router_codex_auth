import { describe, it, expect } from "vitest";
import {
  REJECT_REASON,
  validateScopedRecord,
} from "../../src/services/codex-sync/core/validation.js";

function buildRecord(overrides = {}) {
  return {
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
    ...overrides,
  };
}

describe("codex-sync validation", () => {
  it("rejects missing composite identity", () => {
    const r = validateScopedRecord(buildRecord({ email: "" }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REJECT_REASON.MISSING_COMPOSITE_IDENTITY);
  });

  it("rejects missing credentials", () => {
    const r = validateScopedRecord(buildRecord({ refreshToken: null }));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REJECT_REASON.MISSING_REQUIRED_CREDENTIALS);
  });

  it("rejects invalid revision", () => {
    const r = validateScopedRecord(
      buildRecord({ providerSpecificData: { accountId: "acct_1", inventoryRevision: 0 } }),
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REJECT_REASON.MISSING_OR_INVALID_REVISION);
  });

  it("rejects key mismatch top-level vs nested", () => {
    const r = validateScopedRecord(
      buildRecord({
        inventoryKey: "email:user@example.com|acct:acct_A",
        providerSpecificData: {
          accountId: "acct_1",
          inventoryKey: "email:user@example.com|acct:acct_1",
          inventoryRevision: 2,
        },
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe(REJECT_REASON.INVENTORY_KEY_MISMATCH);
  });

  it("accepts valid scoped record", () => {
    const r = validateScopedRecord(buildRecord());
    expect(r.valid).toBe(true);
    expect(r.normalized.inventoryKey).toBe("email:user@example.com|acct:acct_1");
  });
});
