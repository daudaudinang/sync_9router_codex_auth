import { describe, it, expect } from "vitest";
import {
  deriveInventoryKey,
  normalizeEmail,
  normalizeAccountId,
} from "../../src/services/codex-sync/core/keying.js";

describe("codex-sync identity", () => {
  it("normalizes email", () => {
    expect(normalizeEmail(" User@Example.com ")).toBe("user@example.com");
  });

  it("normalizes account id", () => {
    expect(normalizeAccountId("  acct_123  ")).toBe("acct_123");
  });

  it("derives canonical inventory key", () => {
    expect(deriveInventoryKey("User@Example.com", "acct_1")).toBe(
      "email:user@example.com|acct:acct_1",
    );
  });

  it("returns null when missing identity", () => {
    expect(deriveInventoryKey("", "acct_1")).toBeNull();
    expect(deriveInventoryKey("u@example.com", "")).toBeNull();
  });
});
