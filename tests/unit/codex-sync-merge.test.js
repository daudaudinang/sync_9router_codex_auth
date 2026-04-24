import { describe, it, expect } from "vitest";
import { computeMergePlan } from "../../src/services/codex-sync/core/merge-engine.js";

function localRecord({ key, revision, accessToken = "a" }) {
  return {
    provider: "codex",
    authType: "oauth",
    email: "user@example.com",
    displayName: null,
    name: "user@example.com",
    isActive: true,
    priority: 1,
    testStatus: "active",
    accessToken,
    refreshToken: "rt",
    providerSpecificData: {
      accountId: "acct_1",
      inventoryKey: key,
      inventoryRevision: revision,
      inventorySyncUpdatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function remoteRecord({ key, revision, accessToken = "a" }) {
  return {
    provider: "codex",
    authType: "oauth",
    inventoryKey: key,
    credentials: {
      accessToken,
      refreshToken: "rt",
      idToken: null,
      expiresAt: null,
    },
    metadata: {
      email: "user@example.com",
      displayName: null,
      name: null,
      isActive: true,
      priority: 1,
      testStatus: "active",
      providerSpecificData: {
        accountId: "acct_1",
        orgTitle: null,
        inventoryKey: key,
        inventoryRevision: revision,
        inventorySyncUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

describe("codex-sync merge", () => {
  it("pushes local when local revision is greater", () => {
    const key = "email:user@example.com|acct:acct_1";
    const plan = computeMergePlan({
      localRecords: [localRecord({ key, revision: 3 })],
      remoteRecords: [remoteRecord({ key, revision: 2 })],
    });

    expect(plan.counts.pushedToRemote).toBe(1);
    expect(plan.counts.pulledFromRemote).toBe(0);
  });

  it("pulls remote when remote revision is greater", () => {
    const key = "email:user@example.com|acct:acct_1";
    const plan = computeMergePlan({
      localRecords: [localRecord({ key, revision: 1 })],
      remoteRecords: [remoteRecord({ key, revision: 2 })],
    });

    expect(plan.counts.pulledFromRemote).toBe(1);
  });

  it("counts unchanged when equal revision and same payload", () => {
    const key = "email:user@example.com|acct:acct_1";
    const plan = computeMergePlan({
      localRecords: [localRecord({ key, revision: 2 })],
      remoteRecords: [remoteRecord({ key, revision: 2 })],
    });

    expect(plan.counts.unchanged).toBe(1);
  });

  it("resolves equal revision payload conflicts deterministically", () => {
    const key = "email:user@example.com|acct:acct_1";
    const plan = computeMergePlan({
      localRecords: [localRecord({ key, revision: 2, accessToken: "aaa" })],
      remoteRecords: [remoteRecord({ key, revision: 2, accessToken: "bbb" })],
    });

    expect(plan.counts.equalRevisionPayloadConflictResolved).toBe(1);
  });
});
