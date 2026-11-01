# Excrow Backend

A Node.js backend prototype for a cryptocurrency escrow platform. It brings together account authentication, buyer/seller escrow workflows, real-time chat, notifications, and an admin API, with Bitcoin and Litecoin wallet utilities.

## Features

- Email/password authentication with bcrypt, JWT access tokens, refresh-token rotation, and database-backed sessions.
- Optional Google and Discord OAuth, with reCAPTCHA checks in production.
- Escrow creation, delivery, completion, cancellation, and dispute workflows.
- Authenticated Socket.IO rooms for escrow chat and deposit notifications.
- Admin APIs for users, escrow moderation, risk flags, audit logs, and platform settings, plus a WebSocket activity feed.
- BIP84 deposit-address derivation and separate Bitcoin/Litecoin transaction-building utilities.
- Liveness/readiness probes, configurable request logging and rate limits, Docker support, and load-testing tools.

## Stack

JavaScript (ES modules), Node.js, Express, MongoDB, Socket.IO, WebSockets, Passport, JWT, and bitcoinjs-lib.

## Run locally

Requirements: Node.js **20.19+** (Node.js 22 recommended), npm, and MongoDB for database-backed endpoints.

```sh
npm ci
```

Copy the configuration template:

```powershell
# PowerShell
Copy-Item .env.example .env
```

```sh
# macOS / Linux
cp .env.example .env
```

Generate a secret and put the result in `JWT_SECRET` in your local `.env`. Generate another for `ADMIN_JWT_SECRET` if you enable the admin API.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `MONGO_URI` to your own MongoDB instance, then start the server:

```sh
npm run dev
# or: npm start
```

The API listens on `http://localhost:3001`. The current database name is `number0`, configured in `src/config/db.js`.

For an HTTP-only demonstration without MongoDB, set `SKIP_DB_CONNECT=true` in `.env` and run `npm start`. `GET /health` works in this mode; `GET /ready` returns `503` and database-backed features are unavailable.

OAuth credentials, CAPTCHA configuration, wallet seeds, and RPC endpoints are optional for the HTTP-only demonstration. The template explains each setting.

## API overview

| Route | Purpose |
| --- | --- |
| `GET /health` | Process liveness; no database access |
| `GET /ready` | MongoDB readiness check |
| `/api/auth` | Registration, login, OAuth, refresh, logout |
| `/api/user`, `/api/profile/:id` | Current user, public profile, account settings |
| `/api/escrow` | Escrow lifecycle and disputes |
| `/api/escrow/chat` | Escrow message history and read status |
| `/api/transactions` | User transaction history |
| `/api/notifications` | Notification inbox and read status |
| `/api/platform/status` | Public maintenance status |
| `/api/admin` | Administration and moderation |

Protected user endpoints accept an `Authorization: Bearer <access-token>` header or the `accessToken` cookie. Tokens are checked against stored sessions. See [the admin API reference](docs/ADMIN_API.md) for admin cookies, headers, endpoints, and live-feed messages.

## Structure

```text
src/
  app.js          Express middleware and route composition
  index.js        HTTP server, Socket.IO, startup and shutdown
  cluster.js      Optional multi-process entrypoint
  config/         MongoDB connection
  controllers/    Express routers and request handlers
  middleware/     Authentication, rate limits, logging, errors
  models/         MongoDB data access and domain operations
  routes/         Health and readiness probes
  services/       Chat, deposit watching, wallets, transaction utilities
  utils/          Validation, logging, client IP helpers
bench/            Node.js and k6 load generators
docs/             Admin API and benchmark documentation
```

## Docker

Configure `.env`, then run:

```sh
docker compose up --build
```

The Compose file runs the backend. Supply a MongoDB instance reachable from the container through `MONGO_URI`; a MongoDB server is not bundled. On Docker Desktop, `host.docker.internal` can be used for a database on the host. Keep `HOST=0.0.0.0` for container access. Stop the service with `docker compose down`.

## Benchmarks

The repository includes a dependency-free Node.js HTTP load generator and k6 scenarios:

```sh
npm run bench:quick
```

Run the API in a separate terminal first. [The benchmark guide](docs/BENCHMARK.md) covers configuration, multi-process runs, and interpreting results. `/health` measures the HTTP layer; it does not measure escrow or database throughput.

## Project scope

This is a portfolio prototype. Wallet operations require initialized master-wallet records, and deposit updates depend on an external blockchain indexer that is not included. Transaction signing/broadcast utilities are separate modules and are not connected to the HTTP escrow release flow.

Deposit change streams require MongoDB Atlas or a replica set; set `ENABLE_DEPOSIT_WATCHER=true` only with that setup. Use one server process for the real-time demo: multiple workers require shared Socket.IO room state and shared rate-limit storage.

There is currently no automated test suite. Syntax and HTTP smoke checks do not validate database workflows or blockchain transactions. Use disposable development credentials and wallets when exploring these integrations.

## Publishing

Keep `.env` local. Git ignores environment files, installed dependencies, logs, database dumps, and benchmark output; `.env.example` contains only local defaults and empty credential fields. Install dependencies with `npm ci` after cloning.

Check earlier commits for credentials as well as the current files when publishing an existing Git history. Use fresh secrets for each deployment.
