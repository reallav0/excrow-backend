# Admin Backend API

Last updated: 2026-03-17

This document describes the implemented admin API in this backend.

## Base URL

- REST base: `/api/admin`
- WebSocket live feed:
  - `/admin/ws/live-feed`
  - `/api/admin/ws/live-feed`

## Required Headers

Send these on admin REST calls:

- `Content-Type: application/json`
- `X-Requested-With: XMLHttpRequest`

## Required Cookies

Authenticated admin REST calls require:

- `sessionToken=<admin_jwt_token>` (HTTP-only cookie set by login)

## Error Contract

All errors return JSON with at least:

```json
{
  "message": "Human readable error message"
}
```

## Admin Auth Configuration

Admin login authenticates against the `users` collection:

- user must exist by `email`
- `password` must match `passwordHash` (bcrypt)
- `roles` must include `admin` or `superadmin`

Supported environment variables:

- `ADMIN_JWT_SECRET` (falls back to `JWT_SECRET`)
- `ADMIN_TOKEN_EXPIRY` (default: `8h`)
- `ADMIN_SESSION_COOKIE_NAME` (default: `sessionToken`)

## Auth Endpoints

### POST `/api/admin/auth/login`

Request:

```json
{
  "email": "admin@example.com",
  "password": "admin123",
  "captchaToken": "recaptcha-token"
}
```

Response:

```json
{
  "message": "Login successful",
  "admin": {
    "id": "1",
    "username": "admin",
    "role": "Admin"
  }
}
```

On success, server sets `sessionToken` cookie (HTTP-only).

### POST `/api/admin/auth/logout`

Invalidates current admin session.

### GET `/api/admin/auth/sessions`

Returns:

```json
{
  "items": [
    {
      "id": "session-id",
      "adminId": "adm_1",
      "admin": "superadmin",
      "role": "Super Admin",
      "ip": "::1",
      "since": "2026-03-16T10:00:00.000Z",
      "createdAt": "2026-03-16T10:00:00.000Z"
    }
  ],
  "total": 1
}
```

### DELETE `/api/admin/auth/sessions/:id`

Revokes a specific admin session.

---

## Dashboard

### GET `/api/admin/dashboard/metrics`

Returns metrics object with keys used by UI, including:

- `activeEscrows`, `fundedEscrows`, `inDispute`, `completedMonth`
- `btcVolumeMonth`, `ltcVolumeMonth`, `platformRevenue`, `lockedFunds`
- `riskAlerts`, `pendingDeposits`, `newUsersDay`, `fraudBlocked`
- `openDisputes`, `adminUsername`, `adminRole`
- `pendingWithdrawals`, `pendingFundsBtc`, `pendingFundsLtc`

### GET `/api/admin/dashboard/feed`

Response:

```json
{
  "items": [
    {
      "type": "deposit",
      "text": "Activity text",
      "ts": "2026-03-16T10:00:00Z"
    }
  ]
}
```

### GET `/api/admin/dashboard/revenue-chart?range=7d|30d|90d`

Response:

```json
{
  "days": [
    {
      "label": "03-16",
      "btc": 0.01,
      "ltc": 0.02,
      "btcPct": 33,
      "ltcPct": 67
    }
  ]
}
```

### GET `/api/admin/dashboard/escrow-status-breakdown`

Response:

```json
{
  "statuses": [
    { "label": "pending", "count": 10, "pct": 50 },
    { "label": "funded", "count": 5, "pct": 25 },
    { "label": "dispute", "count": 2, "pct": 10 },
    { "label": "complete", "count": 2, "pct": 10 },
    { "label": "cancelled", "count": 1, "pct": 5 }
  ]
}
```

---

## WebSocket Live Feed

### Endpoint

- `ws://<host>/admin/ws/live-feed`
- `ws://<host>/api/admin/ws/live-feed`

### Auth

Uses admin session cookie:

- `sessionToken=<admin_jwt_token>`

### Messages from server

```json
{
  "type": "deposit|withdrawal|risk|...",
  "text": "New activity item"
}
```

---

## Escrows

- `GET /api/admin/escrows`
  - Query: `status`, `coin`, `search`, `page`, `limit`
  - Returns `{ escrows, total, page, limit }`
- `GET /api/admin/escrows/:id`
- `POST /api/admin/escrows/:id/release`
- `POST /api/admin/escrows/:id/refund`
- `POST /api/admin/escrows/:id/pause`
- `POST /api/admin/escrows/:id/cancel`
  - Body for actions above:

```json
{ "note": "Internal note (required)" }
```

- `POST /api/admin/escrows/:id/notes`

```json
{ "note": "Internal note (required)" }
```

- `PATCH /api/admin/escrows/:id/status`

```json
{ "status": "custom_status" }
```

- `PATCH /api/admin/escrows/:id/timer`

```json
{ "autoReleaseAt": "2026-03-20T12:00:00Z" }
```

---

## Users

- `GET /api/admin/users`
  - Query: `search`, `kyc`, `banned`, `page`, `limit`
  - Returns `{ users, total, page, limit }`
- `GET /api/admin/users/:id`
- `POST /api/admin/users/:id/ban`

```json
{ "reason": "Admin action — see audit log" }
```

- `POST /api/admin/users/:id/unban`
- `POST /api/admin/users/:id/freeze-withdrawals`
- `PATCH /api/admin/users/:id/risk-score`

```json
{ "score": 0 }
```

- `POST /api/admin/users/:id/verify-kyc`
- `POST /api/admin/users/:id/reset-2fa`
- `POST /api/admin/users/:id/force-logout`

---

## Disputes

- `GET /api/admin/disputes`
  - Query: `severity`, `status`, `page`, `limit`
  - Returns `{ disputes, total, page, limit }`
- `GET /api/admin/disputes/:id`
- `POST /api/admin/disputes/:id/resolve`

```json
{
  "decision": "release|refund|split",
  "buyerPct": 50,
  "sellerPct": 50,
  "rationale": "Decision rationale"
}
```

- `POST /api/admin/disputes/:id/escalate`
- `POST /api/admin/disputes/:id/mark-fraud`

Validation:

- For `decision=split`, `buyerPct + sellerPct` must equal `100`.

---

## Wallet / Chain

- `GET /api/admin/addresses`
- `GET /api/admin/utxos`
- `GET /api/admin/withdrawals`
  - Query: `status`, `page`, `limit`
  - Returns `{ withdrawals, total, page, limit, pendingWithdrawals }`
- `POST /api/admin/withdrawals/:id/approve`
- `POST /api/admin/withdrawals/:id/reject`

```json
{ "reason": "Reason for rejection" }
```

---

## Analytics

- `GET /api/admin/analytics/revenue?range=7d|30d|90d`
- `GET /api/admin/analytics/balances`
- `GET /api/admin/analytics/kpis`
  - Returns `{ kpis: { ... } }`

---

## Risk

- `GET /api/admin/risk/events`
- `GET /api/admin/risk/thresholds`
- `PATCH /api/admin/risk/thresholds`
  - Body: full thresholds object
- `POST /api/admin/risk/events/:id/dismiss`
- `POST /api/admin/risk/events/:id/escalate`

---

## Audit

- `GET /api/admin/audit`
  - Query: `search`, `action`, `from`, `to`, `page`, `limit`
  - Returns `{ logs, total, page, limit }`
- `POST /api/admin/audit/export`
  - Body: same filter object
  - Returns CSV stream with download filename `audit-export-<timestamp>.csv`

---

## Settings

- `GET /api/admin/settings`
- `PATCH /api/admin/settings`
  - Body: entire settings object

Default keys include:

- `platformFeePct`
- `minEscrowBtc`
- `maxEscrowBtc`
- `autoReleaseHours`
- `btcEnabled`
- `ltcEnabled`
- `maintenanceMode`
- `autoFreezeEnabled`
- `kycRequiredEnabled`

---

## Validation Rules Implemented

- Admin auth required on all `/api/admin/*` except login.
- Pagination sanity: `page >= 1`, `1 <= limit <= 100`.
- Enum checks for `range`, escrow filters, dispute filters, decision, withdrawal status.
- Required non-empty:
  - `note` for escrow actions and notes
  - `reason` for ban and withdrawal reject
- Risk score must be integer `0..100`.

## Frontend Session Expiry Handling

If backend returns `401` or `403`, frontend should clear `admin_token` and redirect to:

- `/admin/login?reason=session_expired`
