import { deriveInventoryKey } from "./keying.js";
import { nextRevisionForLocalMutation } from "./revision-policy.js";

function decodeJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function extractIdentityFromIdToken(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload || typeof payload !== "object") {
    return {
      payload: null,
      email: null,
      accountId: null,
    };
  }

  const authClaims =
    payload["https://api.openai.com/auth"] &&
    typeof payload["https://api.openai.com/auth"] === "object"
      ? payload["https://api.openai.com/auth"]
      : {};

  const email =
    typeof payload.email === "string" && payload.email.trim() ? payload.email.trim() : null;
  const accountId =
    typeof authClaims.chatgpt_account_id === "string" && authClaims.chatgpt_account_id.trim()
      ? authClaims.chatgpt_account_id.trim()
      : null;

  return {
    payload,
    email,
    accountId,
  };
}

export function patchCodexIdentityFromIdToken(record, now = new Date().toISOString()) {
  if (record?.provider !== "codex" || record?.authType !== "oauth") {
    return {
      changed: false,
      reason: "out_of_scope",
      record,
    };
  }

  const currentEmail =
    typeof record?.email === "string" && record.email.trim() ? record.email.trim() : null;
  const currentAccountId =
    typeof record?.providerSpecificData?.accountId === "string" &&
    record.providerSpecificData.accountId.trim()
      ? record.providerSpecificData.accountId.trim()
      : null;

  if (currentEmail && currentAccountId) {
    return {
      changed: false,
      reason: "already_complete",
      record,
    };
  }

  const extracted = extractIdentityFromIdToken(record?.idToken);
  if (!extracted.payload) {
    return {
      changed: false,
      reason: "missing_or_invalid_id_token",
      record,
    };
  }

  if (!extracted.email || !extracted.accountId) {
    return {
      changed: false,
      reason: "id_token_missing_identity_claims",
      record,
    };
  }

  const nextRecord = {
    ...record,
    email: currentEmail || extracted.email,
    providerSpecificData: {
      ...(record?.providerSpecificData || {}),
      accountId: currentAccountId || extracted.accountId,
    },
  };

  const inventoryKey = deriveInventoryKey(nextRecord.email, nextRecord?.providerSpecificData?.accountId);
  if (inventoryKey) {
    nextRecord.providerSpecificData.inventoryKey = inventoryKey;
  }

  const nextRevision = nextRevisionForLocalMutation(record, nextRecord);
  nextRecord.providerSpecificData.inventoryRevision = nextRevision;
  nextRecord.providerSpecificData.inventorySyncUpdatedAt = now;

  return {
    changed: true,
    reason: "patched_from_id_token",
    record: nextRecord,
    extracted: {
      email: extracted.email,
      accountId: extracted.accountId,
    },
  };
}

export function backfillCodexIdentityRecords(records, now = new Date().toISOString()) {
  const summary = {
    scanned: 0,
    patched: 0,
    unchanged: 0,
    skipped: 0,
    reasons: {
      already_complete: 0,
      missing_or_invalid_id_token: 0,
      id_token_missing_identity_claims: 0,
      out_of_scope: 0,
      patched_from_id_token: 0,
    },
    patchedRecords: [],
  };

  const nextRecords = records.map((record) => {
    const result = patchCodexIdentityFromIdToken(record, now);

    if (record?.provider === "codex" && record?.authType === "oauth") {
      summary.scanned += 1;
    }

    summary.reasons[result.reason] = (summary.reasons[result.reason] || 0) + 1;

    if (result.changed) {
      summary.patched += 1;
      summary.patchedRecords.push({
        id: result.record?.id || null,
        email: result.record?.email || null,
        accountId: result.record?.providerSpecificData?.accountId || null,
        inventoryRevision: result.record?.providerSpecificData?.inventoryRevision || null,
      });
      return result.record;
    }

    if (result.reason === "already_complete") {
      summary.unchanged += 1;
    } else if (result.reason !== "out_of_scope") {
      summary.skipped += 1;
    }

    return record;
  });

  return {
    records: nextRecords,
    summary,
  };
}
