import { createHash } from "node:crypto";
import { canonicalSyncPayloadForCompare, stableJsonStringify } from "./payloads.js";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function resolveEqualRevisionConflict(localRecord, remoteRecord) {
  const localPayload = canonicalSyncPayloadForCompare(localRecord);
  const remotePayload = canonicalSyncPayloadForCompare(remoteRecord);

  const localCanonical = stableJsonStringify(localPayload);
  const remoteCanonical = stableJsonStringify(remotePayload);

  if (localCanonical === remoteCanonical) {
    return {
      changed: false,
      winner: "none",
      localDigest: sha256Hex(localCanonical),
      remoteDigest: sha256Hex(remoteCanonical),
    };
  }

  const localDigest = sha256Hex(localCanonical);
  const remoteDigest = sha256Hex(remoteCanonical);

  if (localDigest === remoteDigest) {
    const winner = localCanonical <= remoteCanonical ? "local" : "remote";
    return { changed: true, winner, localDigest, remoteDigest };
  }

  const winner = localDigest < remoteDigest ? "local" : "remote";
  return { changed: true, winner, localDigest, remoteDigest };
}
