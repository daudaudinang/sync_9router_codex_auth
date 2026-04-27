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
- `daemon` (phù hợp cho Docker/container)

Ngoài ra có script hỗ trợ:
- `backfill-identity`: backfill `email` + `accountId` cho record Codex OAuth bị thiếu bằng cách decode `idToken`

## Cấu trúc repo
- `scripts/codex-sync-runner.js`: CLI entrypoint
- `src/services/codex-sync/**`: core sync logic
- `tests/unit/codex-sync-*.test.js`: unit tests
- `docs/codex-sync-runner.md`: command/runtime docs
- `docs/codex-sync-ops-checklist.md`: reject reason / error category runbook
- `Dockerfile`: image runner standalone
- `docker-compose.yml`: stack local gồm runner + MinIO

## Yêu cầu
- Node.js >= 20
- npm
- Docker / Docker Compose nếu muốn chạy container
- Nếu test remote thật: có bucket S3/MinIO hợp lệ

## Cài đặt local
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

## Cách chạy local
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

### 5. Chạy foreground daemon
```bash
npm run daemon
```

### 6. Gọi trực tiếp CLI
```bash
node scripts/codex-sync-runner.js start --json
node scripts/codex-sync-runner.js status --json
node scripts/codex-sync-runner.js sync-now --json
node scripts/codex-sync-runner.js stop --json
node scripts/codex-sync-runner.js daemon
```

## Backfill account thiếu email/accountId
Nếu DB có các record Codex OAuth vẫn còn `accessToken` / `refreshToken` / `idToken` nhưng thiếu:
- `email`
- `providerSpecificData.accountId`

thì có thể dùng script ngoài code 9router để vá lại từ claim trong `idToken`.

### Dry-run
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
- chỉ quét `provider=codex`, `authType=oauth`
- decode `idToken`
- điền `email`
- điền `providerSpecificData.accountId`
- tạo `providerSpecificData.inventoryKey`
- bump / set `providerSpecificData.inventoryRevision`
- cập nhật `providerSpecificData.inventorySyncUpdatedAt`

> Lưu ý: sync hiện tại **không chỉ nhìn local DB**. Nếu remote S3/MinIO có account hợp lệ mà local chưa có, runner sẽ **pull về local** trong pha merge (`createdLocal` + `pulledFromRemote`). Điều kiện là record remote cũng phải có đủ composite key `email + accountId` và revision hợp lệ.

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

## 3. Gắn `db.json` thật của cậu vào container
Runner đọc local DB tại `/data/db.json` trong container.

Nếu cậu muốn runner sync trực tiếp từ file host, sửa phần volume trong `docker-compose.yml`:
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

## 4. Gọi lệnh trong container
Vì container runner chạy ở mode `daemon`, cậu có thể gọi command riêng bằng `docker compose exec`:

```bash
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js status --json
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js sync-now --json
docker compose exec codex-sync-runner node scripts/codex-sync-runner.js stop --json
```

> Nếu stop runner trong container thì process daemon sẽ dừng. Khi đó container có thể thoát; chỉ cần `docker compose up -d codex-sync-runner` để chạy lại.

## 5. Chạy chỉ image runner (không compose)
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

### Verify Docker config
```bash
docker compose config
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
