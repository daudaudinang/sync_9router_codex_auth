import { describe, expect, it } from "vitest";
import {
  backfillCodexIdentityRecords,
  patchCodexIdentityFromIdToken,
} from "../../src/services/codex-sync/core/identity-backfill.js";

function buildJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("codex-sync identity backfill", () => {
  it("patches missing email and accountId from idToken", () => {
    const idToken = buildJwt({
      email: "User@Example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    });

    const result = patchCodexIdentityFromIdToken(
      {
        id: "conn_1",
        provider: "codex",
        authType: "oauth",
        accessToken: "at",
        refreshToken: "rt",
        idToken,
        providerSpecificData: {},
      },
      "2026-04-24T13:30:00.000Z",
    );

    expect(result.changed).toBe(true);
    expect(result.record.email).toBe("User@Example.com");
    expect(result.record.providerSpecificData.accountId).toBe("acct_123");
    expect(result.record.providerSpecificData.inventoryKey).toBe(
      "email:user@example.com|acct:acct_123",
    );
    expect(result.record.providerSpecificData.inventoryRevision).toBe(1);
    expect(result.record.providerSpecificData.inventorySyncUpdatedAt).toBe(
      "2026-04-24T13:30:00.000Z",
    );
  });

  it("skips records that already have complete composite identity", () => {
    const result = patchCodexIdentityFromIdToken({
      provider: "codex",
      authType: "oauth",
      email: "user@example.com",
      providerSpecificData: {
        accountId: "acct_1",
        inventoryRevision: 3,
      },
      idToken: "ignored",
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("already_complete");
  });

  it("summarizes patched and skipped records deterministically", () => {
    const idToken = buildJwt({
      email: "user2@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_2",
      },
    });

    const { summary } = backfillCodexIdentityRecords([
      {
        id: "conn_1",
        provider: "codex",
        authType: "oauth",
        idToken,
        providerSpecificData: {},
      },
      {
        id: "conn_2",
        provider: "codex",
        authType: "oauth",
        idToken: "bad-token",
        providerSpecificData: {},
      },
    ]);

    expect(summary.scanned).toBe(2);
    expect(summary.patched).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.reasons.patched_from_id_token).toBe(1);
    expect(summary.reasons.missing_or_invalid_id_token).toBe(1);
  });
});
