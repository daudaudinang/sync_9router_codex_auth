# sync_9router_codex_auth

## Mục tiêu
Repo này chạy một **external runner** để đồng bộ token inventory `provider=codex`, `authType=oauth` giữa:
- local DB: `${DATA_DIR}/db.json`
- remote object storage: `S3` hoặc `MinIO`

Runner hỗ trợ các lệnh:
- `start` — khởi động runner nền (background)
- `stop` — dừng runner nền
- `status` — xem trạng thái runner và lần sync gần nhất
- `sync-now` — trigger sync ngay lập tức
- `daemon` — chạy foreground loop (phù hợp cho Docker/container)

Ngoài ra có script hỗ trợ:
- `backfill-identity`: backfill `email` + `accountId` cho record Codex OAuth bị thiếu bằng cách decode `idToken`

---

## Cấu trúc repo
```
scripts/
  codex-sync-runner.js        CLI entrypoint chính
  backfill-codex-identity.js  Script backfill identity thiếu

src/services/codex-sync/
  runner/                     Daemon loop, state store, process manager, IPC
  core/                       Merge engine, validation, tie-breaker, keying
  local/                      Local DB adapter
  remote/                     S3/MinIO client, object codec (encrypt/decrypt)

tests/unit/                   Unit tests (vitest)

docs/
  codex-sync-runner.md        Command & runtime docs
  codex-sync-ops-checklist.md Runbook cho reject reasons & error categories

Dockerfile                    Image runner standalone (node:24-alpine)
docker-compose.yml            Stack local: runner + MinIO
.env.example                  Template biến môi trường
```

---

## Cơ chế hoạt động

### Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────┐
│  Runner (Daemon process)                                │
│                                                         │
│  ┌──────────┐   IPC queue    ┌──────────────────────┐  │
│  │  CLI     │ ─────────────► │  Daemon loop         │  │
│  │ (status, │ ◄───────────── │  (poll + scheduler)  │  │
│  │ sync-now,│   ACK files    └──────────┬───────────┘  │
│  │  stop)   │                           │               │
│  └──────────┘                           ▼               │
│                                  ┌─────────────┐        │
│                                  │ Sync Cycle  │        │
│                                  └──────┬──────┘        │
│                                         │               │
└─────────────────────────────────────────┼───────────────┘
                                          │
               ┌──────────────────────────┼────────────────────┐
               ▼                          ▼                     ▼
        Local db.json            Merge Engine            Remote S3/MinIO
    (read + write back)    (compute merge plan)      (GET + CAS PUT)
```

### Daemon loop

Runner chạy ở mode `daemon` là một **event loop**, không phải cron:

1. **Poll IPC queue** (`DATA_DIR/codex-sync/commands/*.json`) mỗi `CODEX_SYNC_POLL_INTERVAL_MS` (mặc định 150ms)
2. Xử lý command từ CLI (`stop`, `sync-now`) qua file-based IPC — ghi ack file để CLI biết kết quả
3. Kiểm tra `nextScheduledAt` — nếu đến lịch thì chạy sync cycle
4. Nếu có `sync-now` pending → ưu tiên chạy ngay, bỏ qua lịch

### Sync Cycle — 5 pha

Mỗi lần sync chạy qua 5 pha (ghi vào `state.json` để theo dõi):

| Pha | Tên | Mô tả |
|-----|-----|-------|
| 1 | `validate` | Chạy legacy backfill cho record thiếu `inventoryRevision` |
| 2 | `merge` | Tải remote object, tính merge plan (local vs remote) |
| 3 | `local_commit` | Ghi kết quả merge về `db.json` |
| 4 | `remote_commit` | PUT object lên S3/MinIO với CAS headers |
| 5 | `finalize` | Phân loại outcome, ghi `lastRun` vào state |

### Merge Engine — Logic phân giải conflict

Với mỗi `inventoryKey` (`email:<normalized>|acct:<accountId>`):

```
localRecord exists?   remoteRecord exists?   Revision so sánh?   → Kết quả
────────────────────────────────────────────────────────────────────────────
YES                   NO                     —                   → pushedToRemote
NO                    YES                    —                   → pulledFromRemote (createdLocal)
YES                   YES                    local > remote      → pushedToRemote
YES                   YES                    remote > local      → pulledFromRemote
YES                   YES                    local == remote     → tie-break (xem bên dưới)
```

**Tie-break khi revision bằng nhau:**
- So sánh SHA-256 của canonical payload (sorted JSON)
- `digest(local) < digest(remote)` → local thắng → `pushedToRemote`
- `digest(remote) < digest(local)` → remote thắng → `pulledFromRemote`
- Digest bằng nhau → `unchanged` (payload hoàn toàn giống nhau)

Đây là **deterministic tie-break** — không random, không phụ thuộc timestamp.

### CAS atomicity (S3/MinIO)

Khi PUT remote object:
- Nếu object đã tồn tại: gửi header `If-Match: "<etag>"` — chỉ ghi nếu ETag khớp
- Nếu object chưa tồn tại: gửi header `If-None-Match: *` — chỉ ghi nếu chưa có
- Nếu nhận HTTP 412 → `REMOTE_CONFLICT` → tự retry (tối đa 2 lần) bằng cách fetch lại remote

### IPC giữa CLI và Daemon

```
CLI ghi request file:  DATA_DIR/codex-sync/commands/<requestId>.req.json
Daemon đọc + xử lý
Daemon ghi ack file:   DATA_DIR/codex-sync/commands/<requestId>.ack.json
CLI poll ack file trong CODEX_SYNC_ACK_TIMEOUT_MS (mặc định 5000ms)
```

### Runtime files (trong DATA_DIR/codex-sync/)

| File | Vai trò |
|------|---------|
| `state.json` | Trạng thái runner: `runnerState`, `lastRun`, `backfillSummary`, `queue` |
| `runner.pid` | PID của daemon process |
| `start.lock` | Lock tránh race condition khi nhiều `start` cùng lúc |
| `writer.lock` | Single-writer guard — đảm bảo chỉ 1 daemon chạy |
| `commands/*.json` | IPC queue: request + ack files |

---

## Yêu cầu
- Node.js >= 20 (Docker image dùng `node:24-alpine`)
- npm
- Docker / Docker Compose nếu muốn chạy container
- Nếu dùng remote thật: có bucket S3/MinIO hợp lệ

---

## Cài đặt local
```bash
npm install
```

---

## Biến môi trường

### Local runtime
| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `DATA_DIR` | `~/.9router` | Thư mục dữ liệu local chứa `db.json` |
| `CODEX_SYNC_INTERVAL_SEC` | `300` | Chu kỳ scheduler (giây) |
| `CODEX_SYNC_ACK_TIMEOUT_MS` | `5000` | Timeout chờ ACK từ daemon (ms) |
| `CODEX_SYNC_POLL_INTERVAL_MS` | `150` | Poll interval của daemon loop (ms) |

### Remote mode
| Biến | Mặc định | Mô tả |
|------|----------|-------|
| `CODEX_SYNC_REMOTE_MODE` | `file` | Backend: `file` \| `s3` \| `minio` |
| `CODEX_SYNC_OBJECT_KEY` | `inventory/codex-accounts.json` | Key của object trên remote |

#### File mode
- `CODEX_SYNC_REMOTE_FILE=/path/to/remote.json`

#### S3 / MinIO mode
| Biến | Mô tả |
|------|-------|
| `CODEX_SYNC_S3_ENDPOINT` | Endpoint S3/MinIO |
| `CODEX_SYNC_S3_BUCKET` | Tên bucket |
| `CODEX_SYNC_S3_REGION` | Region (mặc định `us-east-1`) |
| `CODEX_SYNC_S3_ACCESS_KEY_ID` | Access key |
| `CODEX_SYNC_S3_SECRET_ACCESS_KEY` | Secret key |
| `CODEX_SYNC_S3_SESSION_TOKEN` | STS session token (optional) |
| `CODEX_SYNC_S3_FORCE_PATH_STYLE` | `true` — bắt buộc cho MinIO |

### Optional encryption
- `SYNC_SHARED_KEY=<shared-key>` — bật chế độ encrypt toàn bộ remote object

---

## Ví dụ cấu hình MinIO remote thật
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

---

## Cách chạy local

### 1. Kiểm tra trạng thái
```bash
npm run status
```

### 2. Start runner (background)
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

### 5. Chạy foreground daemon
```bash
npm run daemon
```

### 6. Watch tests khi phát triển
```bash
npm run test:watch
```

### 7. Gọi trực tiếp CLI
```bash
node scripts/codex-sync-runner.js start --json
node scripts/codex-sync-runner.js status --json
node scripts/codex-sync-runner.js sync-now --json
node scripts/codex-sync-runner.js sync-now --dry-run --json   # không ghi thật
node scripts/codex-sync-runner.js stop --json
node scripts/codex-sync-runner.js daemon
```

---

## Đọc output `status --json`

```json
{
  "runnerState": "runner_running_idle",
  "service": {
    "pid": 1,
    "startedAt": "...",
    "nextScheduledAt": "...",
    "syncIntervalSec": 300
  },
  "currentRun": null,
  "lastRun": {
    "runId": "...",
    "startedAt": "...",
    "endedAt": "...",
    "outcome": "sync_success",
    "phase": "finalize",
    "counts": { ... },
    "rejectReasons": { ... },
    "error": { "category": "none", "detail": null }
  },
  "backfillSummary": { ... },
  "queue": { "syncNowPending": false, "dryRunNextRun": false }
}
```

### Giải thích `runnerState`
| Giá trị | Nghĩa |
|---------|-------|
| `runner_running_idle` | Đang chạy, chờ lịch hoặc command |
| `sync_in_progress` | Đang thực hiện sync cycle |
| `runner_stopped` | Daemon đã dừng |

### Giải thích `lastRun.counts`
| Field | Nghĩa |
|-------|-------|
| `recordsScanned` | Tổng record local được quét |
| `recordsValid` | Số record local hợp lệ (đủ composite key + revision) |
| `recordsRejected` | Số record bị loại (local + remote) |
| `createdLocal` | Record mới được tạo local từ remote |
| `createdRemote` | Record mới được push lên remote từ local |
| `pulledFromRemote` | Record local được cập nhật từ remote (remote thắng) |
| `pushedToRemote` | Record remote được cập nhật từ local (local thắng) |
| `unchanged` | Record giống nhau hoàn toàn ở cả 2 phía |
| `equalRevisionPayloadConflictResolved` | Revision bằng nhau nhưng payload khác → tie-break deterministic |

### Giải thích `lastRun.outcome`
| Giá trị | Nghĩa |
|---------|-------|
| `sync_success` | Cả local và remote commit thành công |
| `sync_partial` | Local commit OK nhưng remote commit thất bại |
| `sync_error` | Lỗi trước khi commit (validate/merge phase) |

---

## Backfill account thiếu email/accountId

Nếu DB có các record Codex OAuth vẫn còn `accessToken` / `refreshToken` / `idToken` nhưng thiếu:
- `email`
- `providerSpecificData.accountId`

thì có thể dùng script để vá lại từ claim trong `idToken`.

### Dry-run (không ghi)
```bash
DATA_DIR=/var/lib/9router npm run backfill-identity
```

### Ghi thật vào DB
```bash
DATA_DIR=/var/lib/9router node scripts/backfill-codex-identity.js --write --json
```

### Chỉ rõ path DB
```bash
node scripts/backfill-codex-identity.js --db-path /var/lib/9router/db.json --write --json
```

Script sẽ:
- Chỉ quét `provider=codex`, `authType=oauth`
- Decode `idToken`
- Điền `email`
- Điền `providerSpecificData.accountId`
- Tạo `providerSpecificData.inventoryKey`
- Bump / set `providerSpecificData.inventoryRevision`
- Cập nhật `providerSpecificData.inventorySyncUpdatedAt`

> **Lưu ý:** Sync hiện tại **không chỉ nhìn local DB**. Nếu remote S3/MinIO có account hợp lệ mà local chưa có, runner sẽ **pull về local** trong pha merge (`createdLocal` + `pulledFromRemote`). Điều kiện là record remote cũng phải có đủ composite key `email + accountId` và revision hợp lệ.

---

# Docker

## 1. Chạy nhanh bằng Docker Compose (local MinIO đi kèm)

Repo đã có sẵn `docker-compose.yml` gồm 3 service:
- `minio`: object storage local
- `minio-init`: tự tạo bucket
- `codex-sync-runner`: runner chính

### Start stack
```bash
docker compose up -d --build
```

### Xem logs
```bash
docker compose logs -f codex-sync-runner
docker compose logs -f minio
```

### Stop stack
```bash
docker compose down
```

### Xóa luôn volumes
```bash
docker compose down -v
```

## 2. Tài khoản / mật khẩu MinIO trong Docker

Mặc định trong `docker-compose.yml`:
- `MINIO_ROOT_USER=minioadmin`
- `MINIO_ROOT_PASSWORD=supersecret`
- bucket mặc định: `uploads`

Console MinIO mặc định:
- URL: `http://localhost:9001`
- user: `minioadmin`
- password: `supersecret`

API MinIO mặc định:
- endpoint nội bộ cho runner: `http://minio:9000`
- endpoint ngoài host: `http://localhost:9000`

Nếu muốn đổi, tạo file `.env` cạnh `docker-compose.yml`:
```bash
MINIO_ROOT_USER=myminio
MINIO_ROOT_PASSWORD=mysecret123
MINIO_BUCKET=uploads
MINIO_API_PORT=9000
MINIO_CONSOLE_PORT=9001

CODEX_SYNC_REMOTE_MODE=minio
CODEX_SYNC_S3_ENDPOINT=http://minio:9000
CODEX_SYNC_S3_BUCKET=uploads
CODEX_SYNC_S3_REGION=us-east-1
CODEX_SYNC_S3_ACCESS_KEY_ID=myminio
CODEX_SYNC_S3_SECRET_ACCESS_KEY=mysecret123
CODEX_SYNC_S3_FORCE_PATH_STYLE=true
```

Sau đó chạy lại:
```bash
docker compose up -d --build
```

## 3. Gắn `db.json` thật vào container

Runner đọc local DB tại `/data/db.json` trong container.

Nếu muốn runner sync trực tiếp từ file host, sửa phần volume trong `docker-compose.yml`:
```yaml
    volumes:
      - runner-data:/data
      - /absolute/path/to/db.json:/data/db.json
```

Ví dụ:
```yaml
      - /home/huynq/.9router/db.json:/data/db.json
```

> Lưu ý: file host phải tồn tại và container phải có quyền đọc/ghi.

## 4. Gọi lệnh vào container — qua Docker Compose

Vì container runner chạy ở mode `daemon`, gọi command riêng bằng `docker compose exec`:

```bash
# Xem trạng thái
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js status --json

# Trigger sync ngay
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js sync-now --json

# Dry-run sync (không ghi thật)
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js sync-now --dry-run --json

# Dừng runner bên trong container
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js stop --json
```

> **Lưu ý:** Nếu stop runner trong container thì process daemon sẽ dừng. Container có thể thoát; chạy lại bằng `docker compose up -d codex-sync-runner`.

## 5. Gọi lệnh vào container standalone (không qua Compose)

Nếu container được chạy trực tiếp bằng `docker run` (tên container tự đặt hoặc auto), dùng `docker exec`:

```bash
# Xem trạng thái
sudo docker exec <container_name> node scripts/codex-sync-runner.js status --json

# Trigger sync ngay
sudo docker exec <container_name> node scripts/codex-sync-runner.js sync-now --json

# Xem state.json trực tiếp
sudo docker exec <container_name> cat /data/codex-sync/state.json

# Mở shell vào container để debug
sudo docker exec -it <container_name> sh
```

Ví dụ với container tên `codex-sync-runner-remote`:
```bash
sudo docker exec codex-sync-runner-remote node scripts/codex-sync-runner.js status --json
```

**Sự khác biệt:**
| Tình huống | Lệnh |
|---|---|
| Container qua `docker compose` | `docker compose exec codex-sync-runner ...` |
| Container standalone | `docker exec <container_name> ...` |

## 6. Inspect runtime files trong container

```bash
# Xem state đang chạy
docker exec <container_name> cat /data/codex-sync/state.json

# Xem PID
docker exec <container_name> cat /data/codex-sync/runner.pid

# List IPC command queue
docker exec <container_name> ls /data/codex-sync/commands/

# Xem logs realtime
docker logs -f <container_name>
```

## 7. Chạy chỉ image runner (không compose)

Build image:
```bash
docker build -t sync-9router-codex-auth .
```

Run với MinIO remote có sẵn:
```bash
docker run --rm -it \
  -e DATA_DIR=/data \
  -e CODEX_SYNC_REMOTE_MODE=minio \
  -e CODEX_SYNC_S3_ENDPOINT=https://api-minio.littlepea.site \
  -e CODEX_SYNC_S3_BUCKET=uploads \
  -e CODEX_SYNC_S3_REGION=us-east-1 \
  -e CODEX_SYNC_S3_ACCESS_KEY_ID=minioadmin \
  -e CODEX_SYNC_S3_SECRET_ACCESS_KEY=supersecret \
  -e CODEX_SYNC_S3_FORCE_PATH_STYLE=true \
  -v /absolute/path/to/local-data:/data \
  sync-9router-codex-auth
```

---

## Chạy test

### Full unit suite
```bash
npm test
```

### Test 1 file
```bash
npx vitest run --config ./vitest.config.js tests/unit/codex-sync-conflict-loop.test.js
```

### Watch mode khi phát triển
```bash
npm run test:watch
```

### Syntax check CLI
```bash
npm run build
```

### Verify Docker config
```bash
docker compose config
```

---

## Điều kiện dữ liệu local

Runner chỉ sync các record trong `${DATA_DIR}/db.json` có:
- `provider = "codex"`
- `authType = "oauth"`

Identity canonical:
- `email + accountId`
- key format: `email:<normalized_email>|acct:<accountId>`

Freshness canonical:
- chỉ dùng `providerSpecificData.inventoryRevision`

---

## Troubleshooting / Ops

### Reject reasons → hành động xử lý

| `rejectReasons` key | Nghĩa | Hành động |
|---|---|---|
| `missing_composite_identity` | Thiếu `email` hoặc `accountId` | Fix record identity rồi chạy `sync-now` |
| `missing_required_credentials` | Thiếu `accessToken` hoặc `refreshToken` | Re-import OAuth token hợp lệ |
| `missing_or_invalid_inventoryRevision` | Revision thiếu/sai kiểu | Chạy backfill hoặc sửa metadata rồi sync lại |
| `inventory_key_mismatch` | `inventoryKey` không khớp canonical derivation | Chuẩn hóa key theo `email:<normalized>\|acct:<id>` |
| `invalid_record_shape` | Record sai schema | Làm sạch record malformed rồi sync lại |

### Error categories → hành động xử lý

| `error.category` | Nghĩa | Hành động |
|---|---|---|
| `none` | Thành công | Không cần thao tác |
| `remote_conflict` | CAS conflict (412) | Retry `sync-now`; nếu lặp lại thì giảm concurrent writers |
| `remote_timeout` | Timeout remote | Kiểm tra endpoint/network, retry |
| `remote_auth` | Lỗi auth remote (401/403) | Rotate credentials hoặc policy remote |
| `local_io` | Lỗi đọc/ghi local DB | Kiểm tra quyền ghi `DATA_DIR`, disk health |
| `validation` | Payload/schema/encryption fail | Kiểm tra schema, key mã hóa, metadata |
| `unknown` | Lỗi chưa phân loại | Thu thập logs, escalate infra/dev |

---

## Edge cases đã cover

Hiện test/unit + implementation đã cover các nhóm chính:
- Thiếu `email` / thiếu `accountId` → reject `missing_composite_identity`
- Thiếu credentials → reject `missing_required_credentials`
- Invalid / missing `inventoryRevision`
- `inventoryKey` mismatch top-level vs nested
- Equal revision / different payload → deterministic tie-break (SHA-256)
- Local newer / remote newer
- Partial outcome `sync_partial | sync_error | sync_success`
- Wrong encryption key
- Stale PID recovery
- `sync-now` dedupe
- Single-writer guard
- Recurring backfill cho record mới sau first run
- `remote_auth` classification
- CAS conflict loop cho remote object
- Atomic CAS headers cho `s3|minio` (`If-Match` / `If-None-Match`)

## Known limitations (v1)

- Control-plane chỉ qua CLI, chưa có API shim / dashboard UI
- V1 không có delete/tombstone propagation — record chỉ được thêm/cập nhật, không xóa
- Warning `MODULE_TYPELESS_PACKAGE_JSON` trên stderr khi chạy CLI JSON mode (cosmetic, không ảnh hưởng chức năng)
- Test integration end-to-end trên nhiều vendor/object-store khác nhau ngoài MinIO-compatible path chưa có
- Rollout/canary metrics thực chiến trong tải lớn nhiều node thật chưa đo

---

## Docs thêm
- [`docs/codex-sync-runner.md`](docs/codex-sync-runner.md) — command reference & runtime paths
- [`docs/codex-sync-ops-checklist.md`](docs/codex-sync-ops-checklist.md) — reject reason / error category runbook
- [`.env.example`](.env.example) — template đầy đủ tất cả biến môi trường
