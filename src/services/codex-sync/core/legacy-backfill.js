import { deriveInventoryKey } from "./keying.js";
import {
  createRejectReasonCounters,
  REJECT_REASON,
  validateScopedRecord,
} from "./validation.js";

function isValidRevision(value) {
  return Number.isInteger(value) && value >= 1;
}

export async function runLegacyBackfill({ dbAdapter, stateStore, now = new Date().toISOString() }) {
  const rejectReasons = createRejectReasonCounters();

  let summary = null;
  await dbAdapter.writeDb((db) => {
    const providerConnections = Array.isArray(db.providerConnections)
      ? db.providerConnections
      : [];

    let scanned = 0;
    let patched = 0;
    let rejected = 0;

    for (const record of providerConnections) {
      if (record?.provider !== "codex" || record?.authType !== "oauth") {
        continue;
      }

      scanned += 1;
      const validation = validateScopedRecord(record, { requireRevision: false });

      if (!validation.valid) {
        rejectReasons[validation.reason] = (rejectReasons[validation.reason] || 0) + 1;
        rejected += 1;
        continue;
      }

      const canonicalKey = deriveInventoryKey(record.email, record?.providerSpecificData?.accountId);
      if (!canonicalKey) {
        rejectReasons[REJECT_REASON.MISSING_COMPOSITE_IDENTITY] += 1;
        rejected += 1;
        continue;
      }

      let changed = false;
      if (!record.providerSpecificData || typeof record.providerSpecificData !== "object") {
        record.providerSpecificData = {};
        changed = true;
      }

      if (record.providerSpecificData.inventoryKey !== canonicalKey) {
        record.providerSpecificData.inventoryKey = canonicalKey;
        changed = true;
      }

      if (record.inventoryKey !== undefined && record.inventoryKey !== canonicalKey) {
        record.inventoryKey = canonicalKey;
        changed = true;
      }

      if (!isValidRevision(record.providerSpecificData.inventoryRevision)) {
        record.providerSpecificData.inventoryRevision = 1;
        changed = true;
      }

      if (changed) {
        record.providerSpecificData.inventorySyncUpdatedAt = now;
        patched += 1;
      }
    }

    summary = {
      scanned,
      patched,
      rejected,
      completedAt: now,
      ran: true,
      rejectReasons,
    };

    return db;
  });

  if (!summary) {
    summary = {
      scanned: 0,
      patched: 0,
      rejected: 0,
      completedAt: now,
      ran: true,
      rejectReasons,
    };
  }

  stateStore.update((state) => ({
    ...state,
    backfillSummary: summary,
  }));

  return {
    summary,
    changed: summary.patched > 0,
  };
}
