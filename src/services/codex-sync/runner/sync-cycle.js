import { randomUUID } from "node:crypto";
import { runLegacyBackfill } from "../core/legacy-backfill.js";
import { applyMergedLocalRecords, computeMergePlan } from "../core/merge-engine.js";
import { parseInventoryEnvelope, serializeInventoryEnvelope } from "../remote/object-codec.js";
import { classifyRunOutcome, createLastRunSnapshot } from "./run-summary.js";

function mapErrorCategory(error) {
  if (!error) return "unknown";
  if (error.code === "REMOTE_CONFLICT") return "remote_conflict";
  if (
    error.code === "REMOTE_TIMEOUT" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ECONNRESET" ||
    error.code === "ECONNREFUSED" ||
    error.code === "ENOTFOUND" ||
    error.code === "EAI_AGAIN" ||
    /timeout/i.test(error.message || "")
  ) {
    return "remote_timeout";
  }
  if (
    error.code === "REMOTE_AUTH" ||
    error.statusCode === 401 ||
    error.statusCode === 403 ||
    /accessdenied|invalidaccesskeyid|signaturedoesnotmatch|auth|credential/i.test(
      `${error.code || ""} ${error.message || ""}`,
    )
  ) {
    return "remote_auth";
  }
  if (/decrypt/i.test(error.message || "")) return "validation";
  if (/ELOCKED|EACCES|ENOENT|EPERM/i.test(error.code || "")) return "local_io";
  return "unknown";
}

function nowIso() {
  return new Date().toISOString();
}

export async function runSyncCycle({
  config,
  dbAdapter,
  stateStore,
  remoteClient,
  trigger = "scheduled",
  dryRun = false,
  maxConflictRetries = 2,
}) {
  const runId = randomUUID();
  const startedAt = nowIso();

  stateStore.update((state) => ({
    ...state,
    runnerState: "sync_in_progress",
    currentRun: {
      runId,
      startedAt,
      trigger,
      attempt: 1,
    },
    lastRun: {
      ...state.lastRun,
      runId,
      startedAt,
      phase: "init",
    },
  }));

  let counts = createLastRunSnapshot().counts;
  let rejectReasons = createLastRunSnapshot().rejectReasons;
  let errorCategory = "none";
  let errorDetail = null;

  let localCommitted = false;
  let remoteCommitted = false;
  let remoteAttempted = false;

  try {
    stateStore.update((state) => ({
      ...state,
      lastRun: {
        ...state.lastRun,
        phase: "validate",
      },
    }));

    await runLegacyBackfill({ dbAdapter, stateStore, now: startedAt });

    let remoteSnapshot = await remoteClient.getObject();
    let expectedEtag = remoteSnapshot.etag;
    let expectedExists = remoteSnapshot.exists;

    let attempt = 0;
    while (attempt < maxConflictRetries) {
      attempt += 1;
      stateStore.update((state) => ({
        ...state,
        currentRun: state.currentRun
          ? {
              ...state.currentRun,
              attempt,
              trigger:
                attempt === 1
                  ? state.currentRun.trigger
                  : "retry_after_conflict",
            }
          : null,
      }));

      const localDb = await dbAdapter.readDb();
      const localScoped = dbAdapter.getScopedConnections(localDb);
      const remoteEnvelope = parseInventoryEnvelope(remoteSnapshot.body, {
        encryptionEnabled: config.encryption.enabled,
        sharedKey: config.encryption.sharedKey,
      });

      stateStore.update((state) => ({
        ...state,
        lastRun: {
          ...state.lastRun,
          phase: "merge",
        },
      }));

      const mergePlan = computeMergePlan({
        localRecords: localScoped,
        remoteRecords: remoteEnvelope.records,
      });

      counts = mergePlan.counts;
      rejectReasons = mergePlan.rejectReasons;

      stateStore.update((state) => ({
        ...state,
        lastRun: {
          ...state.lastRun,
          phase: "local_commit",
        },
      }));

      if (!dryRun) {
        await dbAdapter.writeDb((db) =>
          applyMergedLocalRecords(db, mergePlan.mergedLocalRecordsByKey),
        );
      }
      localCommitted = true;

      stateStore.update((state) => ({
        ...state,
        lastRun: {
          ...state.lastRun,
          phase: "remote_commit",
        },
      }));

      const remoteBody = serializeInventoryEnvelope(mergePlan.mergedRemoteRecords, {
        encryptionEnabled: config.encryption.enabled,
        sharedKey: config.encryption.sharedKey,
      });

      if (dryRun) {
        remoteCommitted = true;
        break;
      }

      remoteAttempted = true;
      try {
        const putResult = await remoteClient.putObject({
          body: remoteBody,
          expectedEtag,
          expectedExists,
        });
        expectedEtag = putResult.etag;
        expectedExists = true;
        remoteCommitted = true;
        break;
      } catch (error) {
        if (error.code === "REMOTE_CONFLICT" && attempt < maxConflictRetries) {
          errorCategory = "remote_conflict";
          errorDetail = error.message;
          remoteSnapshot = await remoteClient.getObject();
          expectedEtag = remoteSnapshot.etag;
          expectedExists = remoteSnapshot.exists;
          continue;
        }
        throw error;
      }
    }

    if (!remoteCommitted && !dryRun) {
      throw Object.assign(new Error("Remote commit failed after retries"), {
        code: "REMOTE_CONFLICT",
      });
    }
  } catch (error) {
    errorCategory = mapErrorCategory(error);
    errorDetail = error?.message || String(error);
  }

  const finalized = classifyRunOutcome({
    localCommitted,
    remoteCommitted,
    remoteAttempted,
    errorCategory,
  });

  const endedAt = nowIso();

  const lastRun = {
    runId,
    startedAt,
    endedAt,
    outcome: finalized.outcome,
    phase: "finalize",
    counts,
    rejectReasons,
    error: {
      category: finalized.category,
      detail: finalized.category === "none" ? null : errorDetail || "Sync cycle failed",
    },
  };

  stateStore.update((state) => ({
    ...state,
    runnerState: "runner_running_idle",
    currentRun: null,
    lastRun,
  }));

  return {
    runId,
    startedAt,
    endedAt,
    outcome: lastRun.outcome,
    lastRun,
  };
}
