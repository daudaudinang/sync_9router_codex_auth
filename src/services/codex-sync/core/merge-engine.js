import { randomUUID } from "node:crypto";
import { deriveInventoryKey } from "./keying.js";
import {
  classifyScopedRecords,
  createRejectReasonCounters,
  validateScopedRecord,
} from "./validation.js";
import { resolveEqualRevisionConflict } from "./tie-breaker.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeRejectReasons(base, extra) {
  const next = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    next[key] = (next[key] || 0) + value;
  }
  return next;
}

function toRemoteRecord(localRecord) {
  const inventoryKey =
    localRecord?.providerSpecificData?.inventoryKey ||
    deriveInventoryKey(localRecord?.email, localRecord?.providerSpecificData?.accountId);

  return {
    provider: "codex",
    authType: "oauth",
    inventoryKey,
    credentials: {
      accessToken: localRecord.accessToken,
      refreshToken: localRecord.refreshToken,
      idToken: localRecord.idToken || null,
      expiresAt: localRecord.expiresAt || null,
    },
    metadata: {
      email: localRecord.email,
      displayName: localRecord.displayName || null,
      name: localRecord.name || localRecord.email || null,
      isActive: localRecord.isActive ?? true,
      priority: localRecord.priority ?? 1,
      testStatus: localRecord.testStatus || "active",
      providerSpecificData: {
        accountId: localRecord?.providerSpecificData?.accountId,
        orgTitle: localRecord?.providerSpecificData?.orgTitle || null,
        inventoryKey,
        inventoryRevision: localRecord?.providerSpecificData?.inventoryRevision,
        inventorySyncUpdatedAt: localRecord?.providerSpecificData?.inventorySyncUpdatedAt || null,
      },
    },
  };
}

function toLocalRecord(remoteRecord, existingLocal = null) {
  const metadata = remoteRecord?.metadata || {};
  const psd = metadata?.providerSpecificData || {};
  const inventoryKey = remoteRecord.inventoryKey || psd.inventoryKey;
  const now = new Date().toISOString();

  const baseline = existingLocal
    ? clone(existingLocal)
    : {
        id: randomUUID(),
        provider: "codex",
        authType: "oauth",
        isActive: true,
        priority: 1,
        createdAt: now,
      };

  const next = {
    ...baseline,
    provider: "codex",
    authType: "oauth",
    email: metadata.email || baseline.email || null,
    displayName: metadata.displayName || baseline.displayName || null,
    name: metadata.name || baseline.name || metadata.email || null,
    isActive: metadata.isActive ?? baseline.isActive ?? true,
    priority: metadata.priority ?? baseline.priority ?? 1,
    testStatus: metadata.testStatus || baseline.testStatus || "active",
    accessToken: remoteRecord?.credentials?.accessToken || baseline.accessToken || null,
    refreshToken: remoteRecord?.credentials?.refreshToken || baseline.refreshToken || null,
    idToken: remoteRecord?.credentials?.idToken || baseline.idToken || null,
    expiresAt: remoteRecord?.credentials?.expiresAt || baseline.expiresAt || null,
    providerSpecificData: {
      ...(baseline.providerSpecificData || {}),
      accountId: psd.accountId || baseline?.providerSpecificData?.accountId || null,
      orgTitle: psd.orgTitle || baseline?.providerSpecificData?.orgTitle || null,
      inventoryKey,
      inventoryRevision: psd.inventoryRevision,
      inventorySyncUpdatedAt: psd.inventorySyncUpdatedAt || now,
    },
    inventoryKey,
    updatedAt: now,
  };

  return next;
}

function normalizeRemoteRecord(remoteRecord) {
  const localShape = {
    provider: remoteRecord?.provider || "codex",
    authType: remoteRecord?.authType || "oauth",
    email: remoteRecord?.metadata?.email,
    accessToken: remoteRecord?.credentials?.accessToken,
    refreshToken: remoteRecord?.credentials?.refreshToken,
    idToken: remoteRecord?.credentials?.idToken || null,
    expiresAt: remoteRecord?.credentials?.expiresAt || null,
    displayName: remoteRecord?.metadata?.displayName || null,
    name: remoteRecord?.metadata?.name || null,
    isActive: remoteRecord?.metadata?.isActive ?? true,
    priority: remoteRecord?.metadata?.priority ?? 1,
    testStatus: remoteRecord?.metadata?.testStatus || "active",
    providerSpecificData: {
      accountId: remoteRecord?.metadata?.providerSpecificData?.accountId,
      orgTitle: remoteRecord?.metadata?.providerSpecificData?.orgTitle || null,
      inventoryKey:
        remoteRecord?.metadata?.providerSpecificData?.inventoryKey || remoteRecord?.inventoryKey,
      inventoryRevision: remoteRecord?.metadata?.providerSpecificData?.inventoryRevision,
      inventorySyncUpdatedAt:
        remoteRecord?.metadata?.providerSpecificData?.inventorySyncUpdatedAt || null,
    },
    inventoryKey: remoteRecord?.inventoryKey,
  };

  return localShape;
}

export function computeMergePlan({ localRecords = [], remoteRecords = [] }) {
  const counts = {
    recordsScanned: localRecords.length,
    recordsValid: 0,
    recordsRejected: 0,
    createdLocal: 0,
    createdRemote: 0,
    pulledFromRemote: 0,
    pushedToRemote: 0,
    unchanged: 0,
    equalRevisionPayloadConflictResolved: 0,
  };

  const localClassified = classifyScopedRecords(localRecords, { requireRevision: true });
  const remoteAsLocal = remoteRecords.map(normalizeRemoteRecord);
  const remoteClassified = classifyScopedRecords(remoteAsLocal, { requireRevision: true });

  counts.recordsValid = localClassified.ready.length;
  counts.recordsRejected = localClassified.rejected.length + remoteClassified.rejected.length;

  const rejectReasons = mergeRejectReasons(
    localClassified.counters,
    mergeRejectReasons(createRejectReasonCounters(), remoteClassified.counters),
  );

  const localMap = new Map();
  for (const item of localClassified.ready) {
    localMap.set(item.normalized.inventoryKey, clone(item.record));
  }

  const remoteMap = new Map();
  for (const item of remoteClassified.ready) {
    remoteMap.set(item.normalized.inventoryKey, toRemoteRecord(item.record));
  }

  const allKeys = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const mergedLocalMap = new Map();
  const mergedRemoteMap = new Map();

  for (const key of allKeys) {
    const localRecord = localMap.get(key);
    const remoteRecord = remoteMap.get(key);

    if (localRecord && !remoteRecord) {
      counts.createdRemote += 1;
      counts.pushedToRemote += 1;

      mergedLocalMap.set(key, clone(localRecord));
      mergedRemoteMap.set(key, toRemoteRecord(localRecord));
      continue;
    }

    if (!localRecord && remoteRecord) {
      const localFromRemote = toLocalRecord(remoteRecord);
      counts.createdLocal += 1;
      counts.pulledFromRemote += 1;

      mergedLocalMap.set(key, localFromRemote);
      mergedRemoteMap.set(key, clone(remoteRecord));
      continue;
    }

    const localRevision = localRecord?.providerSpecificData?.inventoryRevision;
    const remoteRevision = remoteRecord?.metadata?.providerSpecificData?.inventoryRevision;

    if (localRevision > remoteRevision) {
      counts.pushedToRemote += 1;
      mergedLocalMap.set(key, clone(localRecord));
      mergedRemoteMap.set(key, toRemoteRecord(localRecord));
      continue;
    }

    if (remoteRevision > localRevision) {
      counts.pulledFromRemote += 1;
      const localFromRemote = toLocalRecord(remoteRecord, localRecord);
      mergedLocalMap.set(key, localFromRemote);
      mergedRemoteMap.set(key, clone(remoteRecord));
      continue;
    }

    const normalizedRemoteLocal = normalizeRemoteRecord(remoteRecord);
    const conflict = resolveEqualRevisionConflict(localRecord, normalizedRemoteLocal);

    if (!conflict.changed) {
      counts.unchanged += 1;
      mergedLocalMap.set(key, clone(localRecord));
      mergedRemoteMap.set(key, clone(remoteRecord));
      continue;
    }

    // Equal revision + different payload = local was mutated without revision bump
    // (e.g. 9router refreshed token but didn't bump inventoryRevision).
    // Bump local revision so local wins. This implements "first to sync wins" semantic.
    counts.equalRevisionPayloadConflictResolved += 1;
    counts.pushedToRemote += 1;

    const bumpedLocal = clone(localRecord);
    bumpedLocal.providerSpecificData.inventoryRevision = localRevision + 1;
    bumpedLocal.providerSpecificData.inventorySyncUpdatedAt = new Date().toISOString();

    mergedLocalMap.set(key, bumpedLocal);
    mergedRemoteMap.set(key, toRemoteRecord(bumpedLocal));
  }

  return {
    counts,
    rejectReasons,
    mergedLocalRecordsByKey: mergedLocalMap,
    mergedRemoteRecordsByKey: mergedRemoteMap,
    mergedRemoteRecords: [...mergedRemoteMap.values()],
  };
}

export function applyMergedLocalRecords(db, mergedLocalRecordsByKey) {
  const providerConnections = Array.isArray(db.providerConnections) ? db.providerConnections : [];
  const consumed = new Set();

  const nextConnections = providerConnections.map((record) => {
    if (record?.provider !== "codex" || record?.authType !== "oauth") {
      return record;
    }

    const check = validateScopedRecord(record, { requireRevision: false });
    if (!check.valid || !check?.normalized?.inventoryKey) {
      return record;
    }

    const key = check.normalized.inventoryKey;
    if (!mergedLocalRecordsByKey.has(key)) {
      return record;
    }

    consumed.add(key);
    return clone(mergedLocalRecordsByKey.get(key));
  });

  for (const [key, record] of mergedLocalRecordsByKey.entries()) {
    if (consumed.has(key)) continue;
    nextConnections.push(clone(record));
  }

  // Dedupe codex/oauth records by inventoryKey — keep only the first match per key.
  // Duplicates can exist from legacy createProviderConnection paths that created
  // multiple records for the same account before email/accountId was populated.
  const seenKeys = new Set();
  const deduped = nextConnections.filter((record) => {
    if (record?.provider !== "codex" || record?.authType !== "oauth") {
      return true;
    }
    const check = validateScopedRecord(record, { requireRevision: false });
    if (!check.valid || !check.normalized?.inventoryKey) {
      return true;
    }
    const key = check.normalized.inventoryKey;
    if (seenKeys.has(key)) {
      return false;
    }
    seenKeys.add(key);
    return true;
  });

  return {
    ...db,
    providerConnections: deduped,
  };
}
