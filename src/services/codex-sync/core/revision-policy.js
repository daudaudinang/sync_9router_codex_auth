import { canonicalSyncPayloadForBump, stableJsonStringify } from "./payloads.js";

export function ensureValidRevision(record) {
  const revision = record?.providerSpecificData?.inventoryRevision;
  if (Number.isInteger(revision) && revision >= 1) {
    return revision;
  }
  return null;
}

export function shouldBumpRevision(beforeRecord, afterRecord) {
  const beforePayload = canonicalSyncPayloadForBump(beforeRecord);
  const afterPayload = canonicalSyncPayloadForBump(afterRecord);
  return stableJsonStringify(beforePayload) !== stableJsonStringify(afterPayload);
}

export function nextRevisionForLocalMutation(beforeRecord, afterRecord) {
  const current = ensureValidRevision(beforeRecord);

  if (!current) {
    return 1;
  }

  if (shouldBumpRevision(beforeRecord, afterRecord)) {
    return current + 1;
  }

  return current;
}
