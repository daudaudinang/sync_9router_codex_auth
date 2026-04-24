export function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export function normalizeAccountId(accountId) {
  if (typeof accountId !== "string") return "";
  return accountId.trim();
}

export function deriveInventoryKey(email, accountId) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedEmail || !normalizedAccountId) return null;
  return `email:${normalizedEmail}|acct:${normalizedAccountId}`;
}

export function pickStoredInventoryKey(record) {
  const topLevelKey = typeof record?.inventoryKey === "string" ? record.inventoryKey.trim() : "";
  const nestedKey =
    typeof record?.providerSpecificData?.inventoryKey === "string"
      ? record.providerSpecificData.inventoryKey.trim()
      : "";

  return {
    topLevelKey,
    nestedKey,
  };
}

export function getCompositeIdentity(record) {
  const email = normalizeEmail(record?.email);
  const accountId = normalizeAccountId(record?.providerSpecificData?.accountId);
  return { email, accountId };
}
