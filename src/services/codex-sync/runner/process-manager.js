import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function atomicWrite(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, String(value), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function parseLockPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const pid = Number.parseInt(parsed.pid, 10);
    const acquiredAt = Number.parseInt(parsed.acquiredAt, 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      acquiredAt: Number.isInteger(acquiredAt) && acquiredAt > 0 ? acquiredAt : null,
    };
  } catch {
    return null;
  }
}

function readLockPayload(lockFile) {
  if (!fs.existsSync(lockFile)) return null;
  const raw = fs.readFileSync(lockFile, "utf8");
  return parseLockPayload(raw);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function readPid(pidFile) {
  if (!fs.existsSync(pidFile)) return null;
  const raw = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearPidFile(pidFile) {
  if (!fs.existsSync(pidFile)) return;
  fs.unlinkSync(pidFile);
}

export function writePidFile(pidFile, pid) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  atomicWrite(pidFile, pid);
}

export function recoverStalePid({ pidFile, stateStore }) {
  const pid = readPid(pidFile);
  if (!pid) {
    stateStore.markStopped();
    return { recovered: false, pid: null };
  }

  if (isProcessAlive(pid)) {
    return { recovered: false, pid };
  }

  clearPidFile(pidFile);
  stateStore.markStopped();
  return { recovered: true, pid: null };
}

export function spawnDetachedRunner({ scriptPath, env = process.env }) {
  const child = spawn(process.execPath, [scriptPath, "daemon"], {
    detached: true,
    stdio: "ignore",
    env,
  });

  child.unref();
  return child.pid;
}

export async function withStartLock(
  { lockFile, timeoutMs = 5000, pollIntervalMs = 50, staleMs = 30000 },
  work,
) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const startedAt = Date.now();
  let lockAcquired = false;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify(
            {
              pid: process.pid,
              acquiredAt: Date.now(),
            },
            null,
            2,
          ),
          "utf8",
        );
      } finally {
        fs.closeSync(fd);
      }
      lockAcquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const lockInfo = readLockPayload(lockFile);
      const lockPid = lockInfo?.pid;
      const lockAgeMs =
        Number.isInteger(lockInfo?.acquiredAt) && lockInfo.acquiredAt > 0
          ? Date.now() - lockInfo.acquiredAt
          : staleMs + 1;

      if (!lockPid || !isProcessAlive(lockPid) || lockAgeMs >= staleMs) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }

      await sleep(pollIntervalMs);
    }
  }

  if (!lockAcquired) {
    const timeoutError = new Error("Timed out waiting for start lock");
    timeoutError.code = "START_LOCK_TIMEOUT";
    throw timeoutError;
  }

  try {
    return await work();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

export function acquireDaemonGuard({ guardFile, pid = process.pid }) {
  fs.mkdirSync(path.dirname(guardFile), { recursive: true });

  const tryAcquire = () => {
    const fd = fs.openSync(guardFile, "wx");
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            pid,
            acquiredAt: Date.now(),
          },
          null,
          2,
        ),
        "utf8",
      );
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    tryAcquire();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    const lockInfo = readLockPayload(guardFile);
    if (!lockInfo?.pid || !isProcessAlive(lockInfo.pid)) {
      fs.rmSync(guardFile, { force: true });
      tryAcquire();
    } else {
      const lockError = new Error("Runner writer guard already held");
      lockError.code = "RUNNER_ALREADY_RUNNING";
      throw lockError;
    }
  }

  return () => {
    fs.rmSync(guardFile, { force: true });
  };
}
