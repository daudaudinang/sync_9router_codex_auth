import { createRejectReasonCounters } from "../core/validation.js";

export function createEmptyCounts() {
  return {
    recordsScanned: 0,
    recordsValid: 0,
    recordsRejected: 0,
    createdLocal: 0,
    createdRemote: 0,
    pulledFromRemote: 0,
    pushedToRemote: 0,
    unchanged: 0,
    equalRevisionPayloadConflictResolved: 0,
  };
}

export function createLastRunSnapshot(overrides = {}) {
  return {
    runId: null,
    startedAt: null,
    endedAt: null,
    outcome: "never_run",
    phase: "init",
    counts: createEmptyCounts(),
    rejectReasons: createRejectReasonCounters(),
    error: {
      category: "none",
      detail: null,
    },
    ...overrides,
  };
}

export function classifyRunOutcome({ localCommitted, remoteCommitted, remoteAttempted, errorCategory }) {
  if (!localCommitted) {
    return {
      outcome: "sync_error",
      category: errorCategory || "local_io",
    };
  }

  if (localCommitted && remoteAttempted && !remoteCommitted) {
    return {
      outcome: "sync_partial",
      category: errorCategory || "remote_timeout",
    };
  }

  return {
    outcome: "sync_success",
    category: "none",
  };
}
