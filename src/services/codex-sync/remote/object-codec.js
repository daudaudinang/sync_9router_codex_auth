import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SCHEMA_VERSION = 3;
const INVENTORY_TYPE = "9router-codex-account-token-inventory";

function deriveAesKey(sharedKey) {
  return createHash("sha256").update(sharedKey).digest();
}

function normalizeRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.filter((record) => record && typeof record === "object");
}

function encodeRawEnvelope(records) {
  return {
    schemaVersion: SCHEMA_VERSION,
    inventoryType: INVENTORY_TYPE,
    generatedAt: new Date().toISOString(),
    records: normalizeRecords(records),
  };
}

function encryptPayload(plaintext, sharedKey) {
  const key = deriveAesKey(sharedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    inventoryType: INVENTORY_TYPE,
    generatedAt: new Date().toISOString(),
    encrypted: true,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  });
}

function decryptPayload(rawObject, sharedKey) {
  if (!rawObject?.encrypted) {
    return rawObject;
  }

  const key = deriveAesKey(sharedKey);
  const iv = Buffer.from(rawObject.iv, "base64");
  const tag = Buffer.from(rawObject.tag, "base64");
  const ciphertext = Buffer.from(rawObject.ciphertext, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(decrypted.toString("utf8"));
}

function validateEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Invalid remote envelope: not an object");
  }
  if (!Array.isArray(envelope.records)) {
    throw new Error("Invalid remote envelope: records must be an array");
  }
  if (envelope.inventoryType !== INVENTORY_TYPE) {
    throw new Error("Invalid remote envelope: unexpected inventoryType");
  }
}

export function serializeInventoryEnvelope(records, options = {}) {
  const envelope = encodeRawEnvelope(records);

  if (!options.encryptionEnabled) {
    return JSON.stringify(envelope, null, 2);
  }

  if (!options.sharedKey) {
    throw new Error("Encryption enabled but shared key is missing");
  }

  return encryptPayload(JSON.stringify(envelope), options.sharedKey);
}

export function parseInventoryEnvelope(rawBody, options = {}) {
  if (!rawBody) {
    return encodeRawEnvelope([]);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid remote envelope: non-JSON payload");
  }

  if (parsed?.encrypted) {
    if (!options.sharedKey) {
      throw new Error("Encrypted payload provided but shared key is missing");
    }

    try {
      parsed = decryptPayload(parsed, options.sharedKey);
    } catch {
      throw new Error("Failed to decrypt remote payload");
    }
  }

  validateEnvelopeShape(parsed);
  return {
    ...encodeRawEnvelope([]),
    ...parsed,
    records: normalizeRecords(parsed.records),
  };
}

export function inventoryEnvelopeDefaults() {
  return {
    schemaVersion: SCHEMA_VERSION,
    inventoryType: INVENTORY_TYPE,
  };
}
