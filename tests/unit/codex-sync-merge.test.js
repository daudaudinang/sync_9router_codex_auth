import { describe, it, expect } from "vitest";
import {
  computeMergePlan,
  applyMergedLocalRecords,
} from "../../src/services/codex-sync/core/merge-engine.js";

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

  it("bumps local revision and pushes when equal revision + different payload", () => {
    const key = "email:user@example.com|acct:acct_1";
    const plan = computeMergePlan({
      localRecords: [localRecord({ key, revision: 2, accessToken: "aaa" })],
      remoteRecords: [remoteRecord({ key, revision: 2, accessToken: "bbb" })],
    });

    expect(plan.counts.equalRevisionPayloadConflictResolved).toBe(1);
    expect(plan.counts.pushedToRemote).toBe(1);
    expect(plan.counts.pulledFromRemote).toBe(0);

    // Local should win — verify merged local record has bumped revision
    const mergedLocal = plan.mergedLocalRecordsByKey.get(key);
    expect(mergedLocal).toBeDefined();
    expect(mergedLocal.providerSpecificData.inventoryRevision).toBe(3);
    expect(mergedLocal.accessToken).toBe("aaa");

    // Remote should also have bumped revision + local's token
    const mergedRemote = plan.mergedRemoteRecords[0];
    expect(mergedRemote.metadata.providerSpecificData.inventoryRevision).toBe(3);
    expect(mergedRemote.credentials.accessToken).toBe("aaa");
  });

  it("does not bump revision when payload is identical (unchanged)", () => {
    const key = "email:user@example.com|acct:acct_1";
    const plan = computeMergePlan({
      localRecords: [localRecord({ key, revision: 5 })],
      remoteRecords: [remoteRecord({ key, revision: 5 })],
    });

    expect(plan.counts.unchanged).toBe(1);
    expect(plan.counts.equalRevisionPayloadConflictResolved).toBe(0);

    const mergedLocal = plan.mergedLocalRecordsByKey.get(key);
    expect(mergedLocal.providerSpecificData.inventoryRevision).toBe(5);
  });
});

describe("applyMergedLocalRecords dedup", () => {
  const key = "email:user@example.com|acct:acct_1";

  it("removes duplicate codex/oauth records with same inventoryKey", () => {
    const rec = localRecord({ key, revision: 3, accessToken: "merged" });
    const mergedMap = new Map([[key, rec]]);

    // DB has 2 records with same inventoryKey (legacy duplicate)
    const db = {
      providerConnections: [
        { ...localRecord({ key, revision: 2, accessToken: "old_a" }), id: "aaa" },
        { ...localRecord({ key, revision: 2, accessToken: "old_b" }), id: "bbb" },
      ],
    };

    const result = applyMergedLocalRecords(db, mergedMap);
    const codexRecords = result.providerConnections.filter(
      (r) => r.provider === "codex" && r.authType === "oauth",
    );

    expect(codexRecords.length).toBe(1);
    expect(codexRecords[0].accessToken).toBe("merged");
  });

  it("preserves non-codex records during dedup", () => {
    const otherRecord = { provider: "github", authType: "token", accessToken: "gh_xxx" };
    const rec = localRecord({ key, revision: 3 });
    const mergedMap = new Map([[key, rec]]);

    const db = {
      providerConnections: [
        otherRecord,
        { ...localRecord({ key, revision: 2 }), id: "aaa" },
        { ...localRecord({ key, revision: 2 }), id: "bbb" },
      ],
    };

    const result = applyMergedLocalRecords(db, mergedMap);
    expect(result.providerConnections.length).toBe(2); // 1 github + 1 codex
    expect(result.providerConnections[0]).toEqual(otherRecord);
  });
});
