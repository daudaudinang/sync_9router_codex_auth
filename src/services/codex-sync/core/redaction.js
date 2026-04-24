const SECRET_PATTERNS = [
  /token/i,
  /secret/i,
  /apikey/i,
  /^key$/i,
  /password/i,
];

function shouldRedact(key) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

function redactValue(value) {
  if (typeof value !== "string") return "[REDACTED]";
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}...[REDACTED]...${value.slice(-2)}`;
}

export function redactSecrets(input) {
  if (Array.isArray(input)) {
    return input.map((item) => redactSecrets(item));
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const next = {};
  for (const [key, value] of Object.entries(input)) {
    if (shouldRedact(key)) {
      next[key] = redactValue(value);
      continue;
    }
    next[key] = redactSecrets(value);
  }

  return next;
}
