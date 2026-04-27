#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildCommandResponse,
} from "../src/services/codex-sync/runner/command-handler.js";
import {
  consumeRequest,
  createCommandAck,
  createCommandRequest,
  listPendingRequests,
  waitForAck,
} from "../src/services/codex-sync/runner/command-transport.js";
import { LocalDbAdapter } from "../src/services/codex-sync/local/db-adapter.js";
import { S3InventoryClient } from "../src/services/codex-sync/remote/s3-client.js";
import { loadRunnerConfig } from "../src/services/codex-sync/runner/config.js";
import {
  acquireDaemonGuard,
  clearPidFile,
  isProcessAlive,
  readPid,
  recoverStalePid,
  spawnDetachedRunner,
  withStartLock,
  writePidFile,
} from "../src/services/codex-sync/runner/process-manager.js";
import { RunnerStateStore } from "../src/services/codex-sync/runner/state-store.js";
import { runSyncCycle } from "../src/services/codex-sync/runner/sync-cycle.js";
import { createDashboardServer } from "../src/services/codex-sync/runner/dashboard-server.js";

function parseArgs(argv) {
  const args = [...argv];
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const command = args.find((arg) => !arg.startsWith("--")) || "status";

  return {
    command,
    json: flags.has("--json"),
    dryRun: flags.has("--dry-run"),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunnerOnline({ stateStore, pidFile, timeoutMs = 4000 }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = readPid(pidFile);
    const state = stateStore.loadState();
    if (pid && isProcessAlive(pid) && state.runnerState !== "runner_stopped") {
      return true;
    }
    await sleep(100);
  }
  return false;
}

function buildStatusPayload({ stateStore, pidFile }) {
  const state = stateStore.loadState();
  const pid = readPid(pidFile);

  if (!pid || !isProcessAlive(pid)) {
    return {
      ...state,
      runnerState: "runner_stopped",
      currentRun: null,
      service: {
        ...state.service,
        pid: null,
        nextScheduledAt: null,
      },
    };
  }

  return {
    ...state,
    service: {
      ...state.service,
      pid,
    },
  };
}

async function runDaemon({ config, stateStore, dbAdapter, remoteClient }) {
  fs.mkdirSync(path.dirname(config.pidFile), { recursive: true });

  let releaseDaemonGuard = null;
  try {
    releaseDaemonGuard = acquireDaemonGuard({
      guardFile: config.writerLockFile,
      pid: process.pid,
    });
  } catch (error) {
    if (error?.code === "RUNNER_ALREADY_RUNNING") {
      return;
    }
    throw error;
  }

  let dashboardServer = null;

  try {
    writePidFile(config.pidFile, process.pid);
    stateStore.markRunning(process.pid);

    // Start dashboard HTTP server
    if (config.dashboard?.enabled) {
      dashboardServer = createDashboardServer({
        stateStore,
        dbAdapter,
        config,
        buildStatusFn: () => buildStatusPayload({ stateStore, pidFile: config.pidFile }),
        sendCommandFn: (request) => sendCommandToRunner({ config, stateStore, request }),
      });
    }

    let stopRequested = false;
    let syncNowPending = false;
    let nextScheduledAt = Date.now() + config.syncIntervalSec * 1000;

    const shutdown = () => {
      stopRequested = true;
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    try {
      while (!stopRequested) {
        const state = stateStore.loadState();

        stateStore.update((current) => ({
          ...current,
          service: {
            ...current.service,
            pid: process.pid,
            nextScheduledAt: new Date(nextScheduledAt).toISOString(),
          },
          queue: {
            ...current.queue,
            syncNowPending,
          },
        }));

        const requests = listPendingRequests(config.commandDir);
        for (const fileName of requests) {
          const request = consumeRequest(config.commandDir, fileName);
          if (!request || !request.command || !request.requestId) {
            continue;
          }

          if (request.command === "stop") {
            const ack = buildCommandResponse({
              status: "success",
              command: "stop",
              code: "stopped",
              requestId: request.requestId,
              runnerStateAfter: "runner_stopped",
            });
            createCommandAck(config.commandDir, ack);
            stopRequested = true;
            break;
          }

          if (request.command === "sync-now") {
            if (syncNowPending) {
              const ack = buildCommandResponse({
                status: "success",
                command: "sync-now",
                code: "sync_already_queued",
                requestId: request.requestId,
                runnerStateAfter: state.runnerState,
                syncNow: {
                  enqueued: true,
                  deduplicated: true,
                },
              });
              createCommandAck(config.commandDir, ack);
              continue;
            }

            syncNowPending = true;
            const ack = buildCommandResponse({
              status: "success",
              command: "sync-now",
              code: "sync_enqueued",
              requestId: request.requestId,
              runnerStateAfter: state.runnerState,
              syncNow: {
                enqueued: true,
                deduplicated: false,
              },
            });
            createCommandAck(config.commandDir, ack);
          }
        }

        if (stopRequested) {
          break;
        }

        const scheduledDue = Date.now() >= nextScheduledAt;
        const shouldRun = syncNowPending || scheduledDue;

        if (shouldRun) {
          const trigger = syncNowPending ? "manual_sync_now" : "scheduled";
          const dryRun = Boolean(syncNowPending && state.queue?.dryRunNextRun);
          syncNowPending = false;

          await runSyncCycle({
            config,
            dbAdapter,
            stateStore,
            remoteClient,
            trigger,
            dryRun,
          });

          stateStore.update((current) => ({
            ...current,
            queue: {
              ...current.queue,
              dryRunNextRun: false,
            },
          }));

          nextScheduledAt = Date.now() + config.syncIntervalSec * 1000;
          continue;
        }

        await sleep(config.pollIntervalMs);
      }
    } finally {
      if (dashboardServer) {
        dashboardServer.close();
      }
      clearPidFile(config.pidFile);
      stateStore.markStopped();
    }
  } finally {
    if (releaseDaemonGuard) {
      releaseDaemonGuard();
    }
  }
}

async function sendCommandToRunner({ config, request, stateStore }) {
  createCommandRequest(config.commandDir, request);
  try {
    return await waitForAck(config.commandDir, request.requestId, {
      timeoutMs: config.ackTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    });
  } catch {
    return buildCommandResponse({
      status: "error",
      command: request.command,
      code: "internal_error",
      requestId: request.requestId,
      runnerStateAfter: "runner_running_idle",
      syncNow:
        request.command === "sync-now"
          ? {
              enqueued: false,
              deduplicated: false,
            }
          : undefined,
    });
  } finally {
    stateStore.update((state) => ({
      ...state,
      queue: {
        ...state.queue,
        dryRunNextRun: false,
      },
    }));
  }
}

async function handleCommand({ args, config, stateStore }) {
  const requestId = randomUUID();

  recoverStalePid({
    pidFile: config.pidFile,
    stateStore,
  });

  const pid = readPid(config.pidFile);
  const running = pid && isProcessAlive(pid);

  if (args.command === "status") {
    return buildStatusPayload({ stateStore, pidFile: config.pidFile });
  }

  if (args.command === "start") {
    if (running) {
      return buildCommandResponse({
        status: "success",
        command: "start",
        code: "already_running",
        requestId,
        runnerStateAfter: "runner_running_idle",
      });
    }

    try {
      return await withStartLock(
        {
          lockFile: config.startLockFile,
          timeoutMs: config.ackTimeoutMs,
          pollIntervalMs: config.pollIntervalMs,
        },
        async () => {
          recoverStalePid({
            pidFile: config.pidFile,
            stateStore,
          });

          const lockedPid = readPid(config.pidFile);
          const lockedRunning = lockedPid && isProcessAlive(lockedPid);
          if (lockedRunning) {
            return buildCommandResponse({
              status: "success",
              command: "start",
              code: "already_running",
              requestId,
              runnerStateAfter: "runner_running_idle",
            });
          }

          spawnDetachedRunner({
            scriptPath: path.resolve(process.argv[1]),
            env: process.env,
          });

          const online = await waitForRunnerOnline({
            stateStore,
            pidFile: config.pidFile,
            timeoutMs: config.ackTimeoutMs,
          });

          if (!online) {
            return buildCommandResponse({
              status: "error",
              command: "start",
              code: "internal_error",
              requestId,
              runnerStateAfter: "runner_stopped",
            });
          }

          return buildCommandResponse({
            status: "success",
            command: "start",
            code: "started",
            requestId,
            runnerStateAfter: "runner_running_idle",
          });
        },
      );
    } catch {
      const online = await waitForRunnerOnline({
        stateStore,
        pidFile: config.pidFile,
        timeoutMs: config.ackTimeoutMs,
      });

      if (online) {
        return buildCommandResponse({
          status: "success",
          command: "start",
          code: "already_running",
          requestId,
          runnerStateAfter: "runner_running_idle",
        });
      }

      return buildCommandResponse({
        status: "error",
        command: "start",
        code: "internal_error",
        requestId,
        runnerStateAfter: "runner_stopped",
      });
    }
  }

  if (args.command === "stop") {
    if (!running) {
      return buildCommandResponse({
        status: "success",
        command: "stop",
        code: "already_stopped",
        requestId,
        runnerStateAfter: "runner_stopped",
      });
    }

    return sendCommandToRunner({
      config,
      stateStore,
      request: {
        requestId,
        command: "stop",
      },
    });
  }

  if (args.command === "sync-now") {
    if (!running) {
      return buildCommandResponse({
        status: "rejected",
        command: "sync-now",
        code: "runner_not_running",
        requestId,
        runnerStateAfter: "runner_stopped",
        syncNow: {
          enqueued: false,
          deduplicated: false,
        },
      });
    }

    if (args.dryRun) {
      stateStore.update((state) => ({
        ...state,
        queue: {
          ...state.queue,
          dryRunNextRun: true,
        },
      }));
    }

    return sendCommandToRunner({
      config,
      stateStore,
      request: {
        requestId,
        command: "sync-now",
        dryRun: args.dryRun,
      },
    });
  }

  return buildCommandResponse({
    status: "rejected",
    command: args.command,
    code: "unknown_command",
    requestId,
    runnerStateAfter: running ? "runner_running_idle" : "runner_stopped",
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadRunnerConfig();
  const stateStore = new RunnerStateStore({
    stateFile: config.stateFile,
    syncIntervalSec: config.syncIntervalSec,
  });
  const dbAdapter = new LocalDbAdapter({ dataDir: config.dataDir, dbPath: config.dbPath });
  const remoteClient = new S3InventoryClient(config.remote);

  if (args.command === "daemon") {
    await runDaemon({ config, stateStore, dbAdapter, remoteClient });
    return;
  }

  const result = await handleCommand({ args, config, stateStore });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`[codex-sync-runner] ${message}\n`);
  process.exit(1);
});
