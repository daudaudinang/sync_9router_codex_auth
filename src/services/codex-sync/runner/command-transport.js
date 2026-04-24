import fs from "node:fs";
import path from "node:path";

function atomicWriteJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

export function ensureCommandDirectory(commandDir) {
  fs.mkdirSync(commandDir, { recursive: true });
}

export function createCommandRequest(commandDir, payload) {
  ensureCommandDirectory(commandDir);
  const requestFile = path.join(commandDir, `${payload.requestId}.json`);
  atomicWriteJson(requestFile, payload);
  return requestFile;
}

export function createCommandAck(commandDir, payload) {
  ensureCommandDirectory(commandDir);
  const ackFile = path.join(commandDir, `${payload.result.requestId}.ack.json`);
  atomicWriteJson(ackFile, payload);
  return ackFile;
}

export function listPendingRequests(commandDir) {
  ensureCommandDirectory(commandDir);
  return fs
    .readdirSync(commandDir)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".ack.json"))
    .sort();
}

export function consumeRequest(commandDir, requestFileName) {
  const requestPath = path.join(commandDir, requestFileName);
  const raw = fs.readFileSync(requestPath, "utf8");
  const payload = JSON.parse(raw);
  fs.unlinkSync(requestPath);
  return payload;
}

export async function waitForAck(commandDir, requestId, options = {}) {
  ensureCommandDirectory(commandDir);

  const timeoutMs = options.timeoutMs || 5000;
  const pollIntervalMs = options.pollIntervalMs || 100;
  const startedAt = Date.now();
  const ackPath = path.join(commandDir, `${requestId}.ack.json`);

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(ackPath)) {
      const raw = fs.readFileSync(ackPath, "utf8");
      const payload = JSON.parse(raw);
      fs.unlinkSync(ackPath);
      return payload;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const error = new Error("Timed out waiting for command ack");
  error.code = "ACK_TIMEOUT";
  throw error;
}
