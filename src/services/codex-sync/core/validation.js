import { deriveInventoryKey, getCompositeIdentity, pickStoredInventoryKey } from "./keying.js";

export const REJECT_REASON = {
  MISSING_COMPOSITE_IDENTITY: "missing_composite_identity",
  MISSING_REQUIRED_CREDENTIALS: "missing_required_credentials",
  MISSING_OR_INVALID_REVISION: "missing_or_invalid_inventoryRevision",
  INVENTORY_KEY_MISMATCH: "inventory_key_mismatch",
  INVALID_RECORD_SHAPE: "invalid_record_shape",
};

export function createRejectReasonCounters() {
  return {
    [REJECT_REASON.MISSING_COMPOSITE_IDENTITY]: 0,
    [REJECT_REASON.MISSING_REQUIRED_CREDENTIALS]: 0,
    [REJECT_REASON.MISSING_OR_INVALID_REVISION]: 0,
    [REJECT_REASON.INVENTORY_KEY_MISMATCH]: 0,
    [REJECT_REASON.INVALID_RECORD_SHAPE]: 0,
  };
}

function isIntegerRevision(value) {
  return Number.isInteger(value) && value >= 1;
}

function isScopedCodexOauth(record) {
  return record?.provider === "codex" && record?.authType === "oauth";
}

function requiredCredentialsPresent(record) {
  return Boolean(record?.accessToken) && Boolean(record?.refreshToken);
}

export function validateScopedRecord(record, options = {}) {
  const requireRevision = options.requireRevision !== false;

  if (!record || typeof record !== "object") {
    return { valid: false, reason: REJECT_REASON.INVALID_RECORD_SHAPE };
  }

  if (!isScopedCodexOauth(record)) {
    return { valid: false, reason: REJECT_REASON.INVALID_RECORD_SHAPE };
  }

  if (!requiredCredentialsPresent(record)) {
    return { valid: false, reason: REJECT_REASON.MISSING_REQUIRED_CREDENTIALS };
  }

  const { email, accountId } = getCompositeIdentity(record);
  if (!email || !accountId) {
    return { valid: false, reason: REJECT_REASON.MISSING_COMPOSITE_IDENTITY };
  }

  const derivedKey = deriveInventoryKey(email, accountId);
  const { topLevelKey, nestedKey } = pickStoredInventoryKey(record);

  if (topLevelKey && nestedKey && topLevelKey !== nestedKey) {
    return { valid: false, reason: REJECT_REASON.INVENTORY_KEY_MISMATCH };
  }

  const storedKey = nestedKey || topLevelKey;
  if (storedKey && storedKey !== derivedKey) {
    return { valid: false, reason: REJECT_REASON.INVENTORY_KEY_MISMATCH };
  }

  const revision = record?.providerSpecificData?.inventoryRevision;
  if (requireRevision && !isIntegerRevision(revision)) {
    return { valid: false, reason: REJECT_REASON.MISSING_OR_INVALID_REVISION };
  }

  return {
    valid: true,
    reason: null,
    normalized: {
      email,
      accountId,
      inventoryKey: derivedKey,
      inventoryRevision: isIntegerRevision(revision) ? revision : null,
    },
  };
}

export function classifyScopedRecords(records = [], options = {}) {
  const counters = createRejectReasonCounters();
  const ready = [];
  const rejected = [];

  for (const record of records) {
    const result = validateScopedRecord(record, options);
    if (result.valid) {
      ready.push({ record, normalized: result.normalized });
      continue;
    }

    counters[result.reason] = (counters[result.reason] || 0) + 1;
    rejected.push({ record, reason: result.reason });
  }

  return { ready, rejected, counters };
}
