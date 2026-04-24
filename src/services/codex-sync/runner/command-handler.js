import { randomUUID } from "node:crypto";
import { resolveMessage } from "./message-catalog.js";

function nowIso() {
  return new Date().toISOString();
}

function buildEnvelope({ status, command, code, requestId, runnerStateAfter, syncNow }) {
  const result = {
    runnerStateAfter,
    requestId,
    effectiveAt: nowIso(),
  };

  if (command === "sync-now") {
    result.syncNow = {
      enqueued: Boolean(syncNow?.enqueued),
      deduplicated: Boolean(syncNow?.deduplicated),
    };
  }

  return {
    status,
    command,
    code,
    message: resolveMessage(command, code),
    result,
  };
}

export function buildCommandResponse({
  status,
  command,
  code,
  requestId,
  runnerStateAfter,
  syncNow,
}) {
  const resolvedRequestId = requestId || randomUUID();
  return buildEnvelope({
    status,
    command,
    code,
    requestId: resolvedRequestId,
    runnerStateAfter,
    syncNow,
  });
}
