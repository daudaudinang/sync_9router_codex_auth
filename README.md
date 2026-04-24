# sync_9router_codex_auth

Tách riêng phần **Codex OAuth token inventory sync** từ 9router thành repo standalone.

## Mục tiêu
Repo này chạy một **external runner** để đồng bộ token inventory `provider=codex`, `authType=oauth` giữa:
- local DB: `${DATA_DIR}/db.json`
- remote object storage: `S3` hoặc `MinIO`

Runner hỗ trợ:
- `start`
- `stop`
- `status`
- `sync-now`

## Cấu trúc repo
- `scripts/codex-sync-runner.js`: CLI entrypoint
- `src/services/codex-sync/**`: core sync logic
- `tests/unit/codex-sync-*.test.js`: unit tests
- `docs/codex-sync-runner.md`: command/runtime docs
- `docs/codex-sync-ops-checklist.md`: reject reason / error category runbook

## Yêu cầu
- Node.js >= 20
- npm
- Nếu test remote thật: có bucket S3/MinIO hợp lệ

## Cài đặt
```bash
npm install
```

## Biến môi trường chính
### Local runtime
- `DATA_DIR`: thư mục dữ liệu local. Mặc định: `~/.9router`
- `CODEX_SYNC_INTERVAL_SEC`: chu kỳ scheduler, mặc định `300`
- `CODEX_SYNC_ACK_TIMEOUT_MS`: ack timeout, mặc định `5000`
- `CODEX_SYNC_POLL_INTERVAL_MS`: poll interval, mặc định `150`

### Remote mode
- `CODEX_SYNC_REMOTE_MODE=file|s3|minio`
- `CODEX_SYNC_OBJECT_KEY=inventory/codex-accounts.json`

#### File mode
- `CODEX_SYNC_REMOTE_FILE=/path/to/remote.json`

#### S3 / MinIO mode
- `CODEX_SYNC_S3_ENDPOINT=https://...`
- `CODEX_SYNC_S3_BUCKET=uploads`
- `CODEX_SYNC_S3_REGION=us-east-1`
- `CODEX_SYNC_S3_ACCESS_KEY_ID=...`
- `CODEX_SYNC_S3_SECRET_ACCESS_KEY=...`
- `CODEX_SYNC_S3_SESSION_TOKEN=` (optional)
- `CODEX_SYNC_S3_FORCE_PATH_STYLE=true`

### Optional encryption
- `SYNC_SHARED_KEY=<shared-key>`

## Ví dụ cấu hình MinIO
```bash
export DATA_DIR="$HOME/.9router"
export CODEX_SYNC_REMOTE_MODE=minio
export CODEX_SYNC_S3_ENDPOINT="https://api-minio.littlepea.site"
export CODEX_SYNC_S3_BUCKET="uploads"
export CODEX_SYNC_S3_REGION="us-east-1"
export CODEX_SYNC_S3_ACCESS_KEY_ID="minioadmin"
export CODEX_SYNC_S3_SECRET_ACCESS_KEY="supersecret"
export CODEX_SYNC_S3_FORCE_PATH_STYLE=true
```

## Cách chạy
### 1. Kiểm tra trạng thái
```bash
npm run status
```

### 2. Start runner
```bash
npm run start
```

### 3. Trigger sync ngay
```bash
npm run sync-now
```

### 4. Stop runner
```bash
npm run stop
```

### 5. Gọi trực tiếp CLI
```bash
node scripts/codex-sync-runner.js start --json
node scripts/codex-sync-runner.js status --json
node scripts/codex-sync-runner.js sync-now --json
node scripts/codex-sync-runner.js stop --json
```

## Chạy test
### Full unit suite
```bash
npm test
```

### Test 1 file
```bash
npx vitest run --config ./vitest.config.js tests/unit/codex-sync-conflict-loop.test.js
```

### Syntax check CLI
```bash
npm run build
```

## Điều kiện dữ liệu local
Runner chỉ sync các record trong `${DATA_DIR}/db.json` có:
- `provider = "codex"`
- `authType = "oauth"`

Identity canonical:
- `email + accountId`
- key format: `email:<normalized_email>|acct:<accountId>`

Freshness canonical:
- chỉ dùng `providerSpecificData.inventoryRevision`

## Edge cases đã cover
Hiện test/unit + implementation đã cover các nhóm chính:
- thiếu `email` / thiếu `accountId` => reject `missing_composite_identity`
- thiếu credentials => reject `missing_required_credentials`
- invalid / missing `inventoryRevision`
- `inventoryKey` mismatch top-level vs nested
- equal revision / different payload => deterministic tie-break
- local newer / remote newer
- partial outcome `sync_partial | sync_error | sync_success`
- wrong encryption key
- stale pid recovery
- `sync-now` dedupe
- single-writer guard
- recurring backfill cho record mới sau first run
- `remote_auth` classification
- CAS conflict loop cho remote object
- atomic CAS headers cho `s3|minio` (`If-Match` / `If-None-Match`)

## Những gì chưa phải “100% full coverage tuyệt đối”
Vẫn còn vài phần nên coi là residual/follow-up:
- warning `MODULE_TYPELESS_PACKAGE_JSON` trên stderr khi chạy CLI JSON mode
- test integration end-to-end trên nhiều vendor/object-store khác nhau ngoài MinIO-compatible path
- rollout/canary metrics thực chiến trong tải lớn nhiều node thật

## Docs thêm
- `docs/codex-sync-runner.md`
- `docs/codex-sync-ops-checklist.md`

## Nguồn gốc
Code được tách từ implementation `codex-sync` trong repo 9router để dễ reuse / vận hành độc lập.
