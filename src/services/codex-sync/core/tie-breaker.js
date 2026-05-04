import { createHash } from "node:crypto";
import { canonicalSyncPayloadForCompare, stableJsonStringify } from "./payloads.js";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function parseInstantMs(iso) {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Prefer row `updatedAt`, then sync cursor time (remote may only carry the latter). */
function effectiveUpdatedAtMs(record) {
  const top = parseInstantMs(record?.updatedAt);
  if (top !== null) return top;
  return parseInstantMs(record?.providerSpecificData?.inventorySyncUpdatedAt);
}

function digestWinner(localCanonical, remoteCanonical) {
  const localDigest = sha256Hex(localCanonical);
  const remoteDigest = sha256Hex(remoteCanonical);
  if (localDigest === remoteDigest) {
    const winner = localCanonical <= remoteCanonical ? "local" : "remote";
    return { winner, localDigest, remoteDigest };
  }
  const winner = localDigest < remoteDigest ? "local" : "remote";
  return { winner, localDigest, remoteDigest };
}

export function resolveEqualRevisionConflict(localRecord, remoteRecord) {
  const localPayload = canonicalSyncPayloadForCompare(localRecord);
  const remotePayload = canonicalSyncPayloadForCompare(remoteRecord);

  const localCanonical = stableJsonStringify(localPayload);
  const remoteCanonical = stableJsonStringify(remotePayload);

  const localDigest = sha256Hex(localCanonical);
  const remoteDigest = sha256Hex(remoteCanonical);

  if (localCanonical === remoteCanonical) {
    return {
      changed: false,
      winner: "none",
      localDigest,
      remoteDigest,
    };
  }

  const localMs = effectiveUpdatedAtMs(localRecord);
  const remoteMs = effectiveUpdatedAtMs(remoteRecord);

  if (localMs !== null && remoteMs !== null) {
    if (localMs > remoteMs) {
      return { changed: true, winner: "local", localDigest, remoteDigest };
    }
    if (remoteMs > localMs) {
      return { changed: true, winner: "remote", localDigest, remoteDigest };
    }
  } else if (localMs !== null && remoteMs === null) {
    return { changed: true, winner: "local", localDigest, remoteDigest };
  } else if (localMs === null && remoteMs !== null) {
    return { changed: true, winner: "remote", localDigest, remoteDigest };
  }

  const { winner } = digestWinner(localCanonical, remoteCanonical);
  return { changed: true, winner, localDigest, remoteDigest };
}
