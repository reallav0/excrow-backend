# Benchmarking excrow-backend

Goal: sustain **10 000 req/s** and know which layer breaks first.

## TL;DR

Benchmark **`GET /health`**. It is the only endpoint that answers without
touching MongoDB, auth, the rate limiter or the log files, so it measures the
ceiling of the HTTP stack itself. Use `/ready` or `/api/platform/status` when
you want a number that includes the database.

```powershell
# 1. one-time setup
npm ci
Copy-Item .env.example .env    # then fill in JWT_SECRET (and MONGO_URI, or set SKIP_DB_CONNECT=true)

# 2. run the server with all cores + all benchmark switches on
$env:RATE_LIMIT_ENABLED="false"; $env:REQUEST_LOGGING="false"; $env:LOG_TO_FILE="false"; $env:WEB_CONCURRENCY="0"
npm run start:cluster

# 3. in a second terminal: measure
npm run bench            # 200 connections, 30s, uncapped
npm run bench:10k        # 900 connections, 60s, paced at exactly 10 000 req/s
npm run bench:status     # same thing against the MongoDB-backed endpoint
```

For the cleanest 10k number, split the load across two generator processes
instead (`npm run bench:shard-a` and `npm run bench:shard-b` in two terminals,
5000 req/s each) — see "What to expect from the paced mode" below.

Everything runs on the default port **3001**, so the URLs are:

```
http://localhost:3001/health              <- benchmark this one
http://localhost:3001/ready               <- MongoDB ping per request
http://localhost:3001/api/platform/status <- real endpoint, 1 MongoDB read per request
```

## Which endpoint measures what

| Endpoint | Work per request | Use it to measure |
| --- | --- | --- |
| `GET /health` | none: no DB, no auth, no disk, no rate limit, no logging | Max throughput of Node + Express + sockets. This is the 10k req/s target. |
| `GET /ready` | 1 MongoDB `ping` | Round-trip cost of the DB driver/connection pool under load. |
| `GET /api/platform/status` | 1 MongoDB `findOne` | A realistic "cheap" production endpoint. |
| `POST /api/auth/login` | bcrypt + JWT + 2 DB writes | **Not** a throughput target. bcrypt is intentionally ~50-100 ms of CPU per call, so this endpoint tops out at a few hundred req/s per core by design. |

> `POST /api/auth/login` and `POST /api/admin/auth/login` also require a
> reCAPTCHA token whenever `NODE_ENV=production`, which means an outbound call
> to Google per request. Do not include them in a throughput test: with
> `NODE_ENV=development` the CAPTCHA check is skipped, and bcrypt is still the
> bottleneck.

| Tool | Command | Notes |
| --- | --- | --- |
| Built-in runner | `npm run bench` | Zero dependencies, ships with the repo, works offline. |
| autocannon | `npm run bench:autocannon` | Downloads on first use (`npx`). Best quick sanity check. |
| k6 | `npm run bench:k6` | Needs the k6 binary (see below). The only tool here that comfortably drives 10k req/s from one host. |
| wrk / hey | `wrk -t8 -c400 -d60s http://localhost:3001/health` | Fine if you already have them. |

## Installing k6

k6 is a standalone Go binary, **not** an npm package, so `npm ci` does not
install it and `npm run bench:k6` will fail with
`'k6' is not recognized as an internal or external command` until you install it:

```powershell
winget install GrafanaLabs.k6        # Windows (package id, not just "k6")
brew install k6                       # macOS
sudo apt-get install k6               # Debian/Ubuntu
```

Winget adds k6 to the *machine* PATH, which terminals that were already open
will not see — open a new terminal, or just use the npm scripts: they launch k6
through `bench/run-k6.mjs`, which resolves the binary from PATH **or** from
`C:\Program Files\k6\k6.exe`, and prints install instructions if it is missing.

If you would rather not install anything, `npm run bench` and `npm run bench:10k`
need no extra tooling.

## Recorded local measurements (16 logical CPUs, Windows, Node 22)

These are historical development measurements. Raw run artifacts are not
included; reproduce them on your own hardware before using them as a capacity
claim. They measure `/health`, not database or escrow throughput.

`GET /health`, no database, generator on the same box as the server:

| Configuration | Load | Result |
| --- | --- | --- |
| `npm start` (1 process) | 400 connections, uncapped | **4 972 req/s**, p50 81 ms, 0 failed |
| `WEB_CONCURRENCY=1` | k6, 10 000 req/s requested | 70 % connection refusals — a single process tops out near 5k, this is what saturation looks like |
| `WEB_CONCURRENCY=8` | 800 connections, uncapped | 8 500 req/s — generator-bound |
| `WEB_CONCURRENCY=8` | 3 generator processes, 300 connections each | **16 731 req/s combined**, 0 failed |
| `WEB_CONCURRENCY=8` | paced at 10 000 req/s from 2 processes | **9 974 req/s**, p99 103 ms, 0 failed |
| `WEB_CONCURRENCY=16` | k6 steady 10 000 req/s, 30 s | **9 975-9 999 req/s**, p95 1.5-3 ms, 0 server errors |

Two conclusions: the server clears 10 000 req/s with headroom once it gets more
than one core, and a *single* Node generator process tops out at roughly
8-10k req/s on this host. That second number is a property of the load
generator, not the server — which is why the paced 10k run above uses two
generator processes.

Background load and sharing a machine with the generator affect these
measurements. Use an idle machine or a separate load-generation host.

## When k6 reports failures

`npm run bench:k6` breaks every response down so you can tell a server problem
from a client/network artifact:

```
response_status........: 299998
response_error_code....: 550          <- these had no HTTP response at all
http_req_failed........: 0.18% 550 out of 299998
```

| Symptom | Meaning |
| --- | --- |
| `response_status{status:500}` | A real server error — check `logs/error.log`. |
| `response_status{status:429}` | Something is still rate limiting you (`RATE_LIMIT_ENABLED`). |
| `response_error_code{code:1212}`, `dial: connection refused`, `duration=0ms` | The TCP connect was rejected. Either the target is saturated (a single worker at 10k req/s refuses ~70 % of connections) or ~1000 VUs dialed at once and overflowed the Windows accept queue. |
| `http_req_failed` rising while latency is flat | Client-side problem, usually the generator running out of CPU. |

The built-in scenario ramps from 10 % of the target instead of dialing every VU
at once, which makes the connect-refused burst disappear (0 failures at 10k
req/s, versus 0.2-0.4 % with a constant-arrival-rate start). Note that the
steady scenario therefore runs `5s + 10s + DURATION`.

## What to expect from the paced mode

`--target-rps` paces requests with a shared token bucket, but the generator is
still closed-loop (one in-flight request per socket), so it can only deliver the
target if:

```
connections >= target_rps x latency_seconds
```

At 10 000 req/s and 100 ms p99 you need `10 000 x 0.1 = 1 000` connections. The
report warns you when it misses the target and prints the connection count you
need. To be safe, run two smaller generators instead of one huge one — each
generator process is limited to one CPU core:

```powershell
# terminal 2
node bench/loadtest.mjs -u http://localhost:3001/health -c 400 -d 60 --target-rps 5000 --label "gen A"
# terminal 3
node bench/loadtest.mjs -u http://localhost:3001/health -c 400 -d 60 --target-rps 5000 --label "gen B"
```

`&` the two together in bash, or `Start-Job` in PowerShell, and add the two
throughput numbers.

> Windows PowerShell 5.1 mangles extra arguments passed through npm
> (`npm run bench -- --duration 10` loses the flags; `cmd.exe` and bash do not).
> Call the runner directly when you need custom options:
> `node bench/loadtest.mjs --url http://localhost:3001/health --connections 400 --duration 60 --target-rps 5000`

## A word about latency percentiles

When the generator shares the machine with the server, its own scheduling
latency is included in p90/p99. On Windows the timer granularity is ~15.6 ms, so
paced runs show a p90 bump that is generator scheduling, not server
processing. For clean percentiles run k6 from a second machine on the same LAN.

## Switching the benchmark mode on

All switches live in `.env` (see `.env.example` for the annotated list) or as
environment variables:

| Variable | Benchmark value | Effect |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `false` | Rate limiting is **off by default**. Set `true` to restore the original 429 limits. |
| `REQUEST_LOGGING` | `false` | Skips the per-request API logger entirely. |
| `REQUEST_LOG_SAMPLE_RATE` | `0.01` | Alternative to the above: keep 1% of request logs. |
| `LOG_TO_FILE` | `false` | No disk writes anywhere (log output is async/streamed). |
| `HTTP_ETAG` | `false` | Skips MD5 hashing of every response body. |
| `WEB_CONCURRENCY` | `0` | `src/cluster.js` forks one worker per CPU core. |
| `SKIP_DB_CONNECT` | `true` | Boots without MongoDB. `/health` still works, `/ready` returns 503. |

## Running the server

### Single process (baseline, one CPU core)

```powershell
npm run start        # node src/index.js
```

### All CPU cores (what you need for 10k req/s)

```powershell
# PowerShell
$env:WEB_CONCURRENCY="0"; npm run start:cluster

# cmd.exe
set WEB_CONCURRENCY=0 && npm run start:cluster

# bash / macOS / Linux
WEB_CONCURRENCY=0 npm run start:cluster
```

`WEB_CONCURRENCY=0` means "one worker per core". On this machine
(`16` logical CPUs) that is 16 workers. Set `WEB_CONCURRENCY=1` to go back to
the single-process topology.

### Docker

```bash
docker compose -f compose.yaml -f compose.benchmark.yaml up --build
```

The override file runs the cluster entrypoint, disables rate limiting / request
logging / log files / ETags, raises the TCP backlog and the file-descriptor
limit. Set `WEB_CONCURRENCY=0` in your shell or `.env` for all CPU cores;
the application template uses `1` for the real-time demo. To benchmark the
HTTP layer with no database at all:

```bash
SKIP_DB_CONNECT=true docker compose -f compose.yaml -f compose.benchmark.yaml up --build
```

## Running the load

### Quick sanity check (10 seconds)

```powershell
npm run bench:quick
```

### Full uncapped run (find the ceiling)

```powershell
npm run bench
```

### Paced at exactly 10 000 req/s

```powershell
npm run bench:10k
```

or directly, with any target:

```powershell
node bench/loadtest.mjs --url http://localhost:3001/health --connections 400 --duration 60 --target-rps 10000
```

### k6 (recommended for the 10k push)

```powershell
npm run bench:k6                      # ramps 500 -> 15 000 req/s and holds (~3m15s)
npm run bench:k6:steady               # ramps in 15s, then holds 10 000 req/s for 60s
$env:ENDPOINT="http://localhost:3001/api/platform/status"; npm run bench:k6
```

The npm scripts launch k6 through `bench/run-k6.mjs`, so no PATH setup is
needed. Use the raw `k6 run bench/k6-loadtest.js -e ...` form only if k6 is
already on your PATH.

### autocannon

```powershell
npm run bench:autocannon
# custom: npx --yes autocannon -c 400 -d 60 -p 1 http://localhost:3001/health
#        -c connections, -d seconds, -p pipelining per connection
```

## Reading the numbers

The built-in runner prints throughput, p50/p90/p99/p99.9/max latency, the status
code mix, transport errors, and per-second jitter:

```
Throughput        12480.31 req/s
Requests          374409 (374409 ok, 0 failed)
Latency           avg 15.94ms | p50 15.10ms | p90 18.20ms | p99 26.44ms | ...
Per-second        min 11902 | avg 12480.3 | max 13085 | jitter(cv) 2.1%
```

What to watch:

- **`failed` > 0 or 429s** → something is still throttling. Check `RATE_LIMIT_ENABLED`.
- **p99 climbing while throughput is flat** → you are at the ceiling; the queue is growing, not the capacity.
- **jitter (cv) above ~10%** → GC pauses or CPU contention. Try more workers, or move the load generator to another machine.
- **`ECONNREFUSED` / `EMFILE` on the client** → raise `--connections` socket limits or the file-descriptor limit on the generator host.
- **Sockets rarely reused** → keep-alive is off somewhere; at 10k req/s connection churn will dominate and you will see `EADDRNOTAVAIL` (ephemeral port exhaustion) on the client.

### Choosing the connection count

Closed-loop generators send the next request as soon as the previous one
returns, so:

```
connections ≈ target_rps × latency_seconds
```

At 10 000 req/s and 20 ms average latency you need at least `10000 × 0.02 = 200`
connections. Use **2-3× that** (`--connections 400`+) so latency spikes do not
throttle the generator itself, and use `--target-rps` when you want a
rate-shaped test rather than a saturation test.

## Hitting 10k req/s: what actually matters

1. **Worker count.** A Node.js event loop runs on one core. Compare `npm start` with `npm run start:cluster` on your own hardware.
2. **No per-request disk I/O.** The old logger used `fs.appendFileSync` twice per request; it is now stream-based and switchable off.
3. **No per-request rate limiting or log formatting.** Both are now pass-throughs in benchmark mode.
4. **Keep-alive everywhere.** Server: `KEEP_ALIVE_TIMEOUT_MS=72000`. Client: the load generator reuses sockets by default.
5. **Keep the database out of the hot path** for the headline number. `/health` has no DB work; `/api/platform/status` will always be DB-bound.
6. **Run the generator away from the server.** Benchmarking a 16-core box from the same box steals cores from the thing you are measuring.

## Before you deploy again

Benchmark mode removes real protections, so restore them for production:

```dotenv
RATE_LIMIT_ENABLED=true
REQUEST_LOGGING=true
LOG_TO_FILE=true
WEB_CONCURRENCY=1     # or add @socket.io/redis-adapter first, see below
```

Two things to keep in mind:

- **Disabling rate limiting also disables per-account login lockouts.** Both follow `RATE_LIMIT_ENABLED`; restore it before exposing authentication endpoints.
- **Real-time state and rate-limit counters are per-process.** With `WEB_CONCURRENCY>1`, broadcasts reach only clients on the same worker. Use shared Socket.IO state, shared rate-limit storage, and session routing appropriate to the transport before running multiple workers for the full application. The raw admin WebSocket feed also needs shared fan-out.

`RATE_LIMIT_ENABLED=true` brings back **all** 429 paths at once: the five
route limiters *and* the per-account login lockouts in `auth.controller.js` and
`admin.controller.js`, which are gated by the same flag.
