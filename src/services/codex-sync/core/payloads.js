import { deriveInventoryKey } from "./keying.js";

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]);
    return Object.fromEntries(entries);
  }

  return value;
}

export function stableJsonStringify(value) {
  return JSON.stringify(sortObject(value));
}

function pickComparablePayload(record = {}) {
  const inventoryKey = deriveInventoryKey(record.email, record?.providerSpecificData?.accountId);

  return {
    email: record.email || null,
    providerSpecificData: {
      accountId: record?.providerSpecificData?.accountId || null,
      inventoryKey: inventoryKey || record?.providerSpecificData?.inventoryKey || null,
      orgTitle: record?.providerSpecificData?.orgTitle || null,
    },
    accessToken: record.accessToken || null,
    refreshToken: record.refreshToken || null,
    idToken: record.idToken || null,
    expiresAt: record.expiresAt || null,
    displayName: record.displayName || null,
    name: record.name || null,
    isActive: record.isActive ?? null,
    priority: record.priority ?? null,
    testStatus: record.testStatus || null,
  };
}

export function canonicalSyncPayloadForCompare(record = {}) {
  return pickComparablePayload(record);
}

export function canonicalSyncPayloadForBump(record = {}) {
  return pickComparablePayload(record);
}
