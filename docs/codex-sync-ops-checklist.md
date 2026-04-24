# Codex Sync Ops Checklist

## Reject reason -> operator action

| rejectReasons key | Meaning | Action |
|---|---|---|
| `missing_composite_identity` | Thiếu `email` hoặc `accountId` | Fix record identity rồi chạy `sync-now` |
| `missing_required_credentials` | Thiếu `accessToken` hoặc `refreshToken` | Re-import OAuth token hợp lệ |
| `missing_or_invalid_inventoryRevision` | Revision thiếu/sai kiểu | Chạy backfill hoặc sửa metadata rồi sync lại |
| `inventory_key_mismatch` | `inventoryKey` không khớp canonical derivation | Chuẩn hóa key theo `email:<normalized>|acct:<id>` |
| `invalid_record_shape` | Record sai schema | Làm sạch record malformed rồi sync lại |

## Error category -> operator action

| error.category | Meaning | Action |
|---|---|---|
| `none` | Run thành công | Không cần thao tác |
| `remote_conflict` | CAS conflict | Retry `sync-now`; nếu lặp lại thì giảm concurrent writers |
| `remote_timeout` | Timeout remote | Kiểm tra endpoint/network, retry |
| `remote_auth` | Lỗi auth remote | Rotate credentials hoặc policy remote |
| `local_io` | Lỗi đọc/ghi local DB | Kiểm tra quyền ghi `DATA_DIR`, disk health |
| `validation` | Payload/schema/encryption fail | Kiểm tra schema, key mã hóa, metadata |
| `unknown` | Lỗi chưa phân loại | Thu thập logs, escalate infra/dev |
