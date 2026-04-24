# Codex Sync Runner (v1)

`codex-sync-runner` là control-plane CLI-only cho đồng bộ inventory `codex/oauth` giữa local `${DATA_DIR}/db.json` và remote object.

## Commands

```bash
node scripts/codex-sync-runner.js start --json
node scripts/codex-sync-runner.js stop --json
node scripts/codex-sync-runner.js status --json
node scripts/codex-sync-runner.js sync-now --json
```

## Runtime paths

- State: `${DATA_DIR}/codex-sync/state.json`
- PID: `${DATA_DIR}/codex-sync/runner.pid`
- Start lock: `${DATA_DIR}/codex-sync/start.lock`
- Writer guard: `${DATA_DIR}/codex-sync/writer.lock`
- IPC queue: `${DATA_DIR}/codex-sync/commands/*.json`

## Key env vars

- `DATA_DIR`: override app data dir (default `~/.9router`)
- `CODEX_SYNC_INTERVAL_SEC`: scheduler interval (default `300`)
- `CODEX_SYNC_ACK_TIMEOUT_MS`: command ack timeout (default `5000`)
- `CODEX_SYNC_REMOTE_MODE`: supports `file` (default), `s3`, `minio`
- `CODEX_SYNC_REMOTE_FILE`: file backend path when mode=`file`
- `CODEX_SYNC_S3_ENDPOINT`: endpoint for mode=`s3|minio` (e.g. `http://127.0.0.1:9000` for MinIO)
- `CODEX_SYNC_S3_BUCKET`: object bucket name for mode=`s3|minio`
- `CODEX_SYNC_S3_REGION`: signing region (default `us-east-1`)
- `CODEX_SYNC_S3_ACCESS_KEY_ID`: access key for mode=`s3|minio`
- `CODEX_SYNC_S3_SECRET_ACCESS_KEY`: secret key for mode=`s3|minio`
- `CODEX_SYNC_S3_SESSION_TOKEN`: optional STS session token
- `CODEX_SYNC_S3_FORCE_PATH_STYLE`: default `true` (recommended cho MinIO)
- `SYNC_SHARED_KEY`: bật chế độ encrypt full-file remote object

## Known v1 limitations

- Control-plane chỉ qua CLI, chưa có API shim dashboard.
- V1 không có delete/tombstone propagation.

## CAS atomicity for `s3|minio`

- Remote PUT uses S3 conditional write headers for atomicity:
  - `If-Match: "<etag>"` when runner has an expected ETag.
  - `If-None-Match: *` when creating without an expected ETag.
- Remote precondition failure (`HTTP 412`) is mapped to `REMOTE_CONFLICT`.
