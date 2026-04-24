export const MESSAGE_CATALOG = {
  start: {
    started: "Runner started.",
    already_running: "Runner already running.",
    invalid_state: "Command rejected: invalid state.",
    internal_error: "Command failed due to internal error.",
  },
  stop: {
    stopped: "Runner stopped.",
    already_stopped: "Runner already stopped.",
    invalid_state: "Command rejected: invalid state.",
    internal_error: "Command failed due to internal error.",
  },
  "sync-now": {
    sync_enqueued: "Sync request enqueued.",
    sync_already_queued: "Sync request already queued.",
    runner_not_running: "Runner is not running.",
    invalid_state: "Command rejected: invalid state.",
    internal_error: "Command failed due to internal error.",
  },
};

const COMMON_CODES = {
  unknown_command: "Unknown command. Supported commands: start, stop, status, sync-now.",
  invalid_state: "Command rejected: invalid state.",
  internal_error: "Command failed due to internal error.",
};

export function resolveMessage(command, code) {
  const commandCatalog = MESSAGE_CATALOG[command] || {};
  if (commandCatalog[code]) {
    return commandCatalog[code];
  }

  if (COMMON_CODES[code]) {
    return COMMON_CODES[code];
  }

  return COMMON_CODES.internal_error;
}
