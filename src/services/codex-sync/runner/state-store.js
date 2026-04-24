import fs from "node:fs";
import path from "node:path";
import { createLastRunSnapshot } from "./run-summary.js";

function nowIso() {
  return new Date().toISOString();
}

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function ensureRuntimeFiles(stateFilePath) {
  const runtimeDir = path.dirname(stateFilePath);
  const commandsDir = path.join(runtimeDir, "commands");
  fs.mkdirSync(commandsDir, { recursive: true });

  if (!fs.existsSync(stateFilePath)) {
    atomicWriteJson(stateFilePath, {});
  }
}

export function createDefaultRunnerState(syncIntervalSec = 300) {
  return {
    runnerState: "runner_stopped",
    service: {
      pid: null,
      startedAt: null,
      nextScheduledAt: null,
      syncIntervalSec,
    },
    currentRun: null,
    lastRun: createLastRunSnapshot(),
    backfillSummary: {
      scanned: 0,
      patched: 0,
      rejected: 0,
      completedAt: null,
      ran: false,
      rejectReasons: {},
    },
    queue: {
      syncNowPending: false,
    },
  };
}

function normalizeState(raw, syncIntervalSec) {
  const defaults = createDefaultRunnerState(syncIntervalSec);
  const state = raw && typeof raw === "object" ? raw : {};

  return {
    ...defaults,
    ...state,
    service: {
      ...defaults.service,
      ...(state.service || {}),
      syncIntervalSec,
    },
    lastRun: {
      ...defaults.lastRun,
      ...(state.lastRun || {}),
      counts: {
        ...defaults.lastRun.counts,
        ...(state.lastRun?.counts || {}),
      },
      rejectReasons: {
        ...defaults.lastRun.rejectReasons,
        ...(state.lastRun?.rejectReasons || {}),
      },
      error: {
        ...defaults.lastRun.error,
        ...(state.lastRun?.error || {}),
      },
    },
    queue: {
      ...defaults.queue,
      ...(state.queue || {}),
    },
    backfillSummary: {
      ...defaults.backfillSummary,
      ...(state.backfillSummary || {}),
    },
  };
}

export class RunnerStateStore {
  constructor(options) {
    this.stateFile = options.stateFile;
    this.syncIntervalSec = options.syncIntervalSec || 300;
    ensureRuntimeFiles(this.stateFile);
  }

  loadState() {
    ensureRuntimeFiles(this.stateFile);
    const raw = fs.readFileSync(this.stateFile, "utf-8");
    const parsed = raw ? JSON.parse(raw) : {};
    return normalizeState(parsed, this.syncIntervalSec);
  }

  saveState(nextState) {
    const normalized = normalizeState(nextState, this.syncIntervalSec);
    atomicWriteJson(this.stateFile, normalized);
    return normalized;
  }

  update(mutator) {
    const current = this.loadState();
    const next = mutator(current) || current;
    return this.saveState(next);
  }

  markStopped() {
    return this.update((state) => ({
      ...state,
      runnerState: "runner_stopped",
      currentRun: null,
      service: {
        ...state.service,
        pid: null,
        nextScheduledAt: null,
      },
    }));
  }

  markRunning(pid) {
    const startedAt = nowIso();
    return this.update((state) => ({
      ...state,
      runnerState: "runner_running_idle",
      service: {
        ...state.service,
        pid,
        startedAt,
      },
    }));
  }
}
