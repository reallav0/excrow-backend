#!/usr/bin/env node
//
// Dependency-free HTTP load generator.
//
// Why not just autocannon/k6? This script needs nothing installed, so it is the
// fallback that always works. For the real 10k req/s push use k6 or autocannon
// (see docs/BENCHMARK.md); this runner is accurate up to roughly 20-30k req/s from a
// single client process and will itself become the bottleneck above that.
//
// Usage:
//   node bench/loadtest.mjs --url http://localhost:3001/health --connections 200 --duration 30
//   node bench/loadtest.mjs --url http://localhost:3001/api/platform/status --target-rps 5000
//
// Run `node bench/loadtest.mjs --help` for all options.

import http from "node:http";
import https from "node:https";
import process from "node:process";

const HELP = `
HTTP load generator (zero dependencies)

Options:
  --url <url>            Target URL (required)
  --method <verb>        HTTP method (default: GET)
  --connections <n>      Concurrent keep-alive sockets (default: 100)
  --duration <seconds>   Measured duration, warmup excluded (default: 30)
  --warmup <seconds>     Warmup period, results discarded (default: 3)
  --target-rps <n>       Cap request rate (default: 0 = as fast as possible)
  --timeout <ms>         Per-request timeout (default: 5000)
  --header "K: V"        Extra header, repeatable
  --body <string>        Request body (sets Content-Type: application/json)
  --label <name>         Label printed with the report
  --track-pids           Count which worker process (pid) answered - reveals
                         whether a cluster is actually spreading the load
  --allow-errors         Exit 0 even if requests failed
  --no-progress          Do not print the live progress line
  -h, --help             Show this help

Examples:
  node bench/loadtest.mjs --url http://localhost:3001/health -c 200 -d 30
  node bench/loadtest.mjs --url http://localhost:3001/api/platform/status --target-rps 10000 -d 60
`;

/** Tiny argv parser: --flag, --key value, -c value, and repeated --header. */
function parseArgs(argv) {
  const out = { header: [] };
  const alias = { c: "connections", d: "duration", u: "url", t: "timeout" };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "-h" || token === "--help") {
      out.help = true;
      continue;
    }

    if (!token.startsWith("-")) continue;

    let key = token.replace(/^--?/, "");
    key = alias[key] || key;

    if (key === "no-progress") {
      out.progress = false;
      continue;
    }
    if (key === "allow-errors") {
      out.allowErrors = true;
      continue;
    }
    if (key === "track-pids") {
      out.trackPids = true;
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      // Boolean flag we do not recognise - ignore rather than crash.
      continue;
    }
    i += 1;

    if (key === "header") {
      out.header.push(value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.url) {
  console.log(HELP.trim());
  process.exit(args.help ? 0 : 1);
}

const target = new URL(args.url);
const isTls = target.protocol === "https:";
const transport = isTls ? https : http;

const config = {
  method: (args.method || "GET").toUpperCase(),
  connections: Math.max(1, Number(args.connections) || 100),
  durationSec: Number(args.duration) || 30,
  warmupSec: Number(args.warmup ?? 3),
  targetRps: Math.max(0, Number(args["target-rps"]) || 0),
  timeoutMs: Math.max(1, Number(args.timeout) || 5000),
  label: args.label || `${target.pathname}`,
  progress: args.progress !== false,
  allowErrors: Boolean(args.allowErrors),
  trackPids: Boolean(args.trackPids),
};

const extraHeaders = {};
for (const raw of args.header) {
  const idx = raw.indexOf(":");
  if (idx === -1) continue;
  extraHeaders[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
}

let requestBody = null;
if (args.body !== undefined) {
  requestBody = Buffer.from(args.body);
  extraHeaders["Content-Type"] = extraHeaders["Content-Type"] || "application/json";
  extraHeaders["Content-Length"] = String(requestBody.byteLength);
}

// One shared agent: sockets are reused across the whole run, which is what
// makes 10k req/s reachable at all (connection setup would dominate otherwise).
const agent = new transport.Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: config.connections,
  maxFreeSockets: config.connections,
  scheduling: "fifo",
  timeout: config.timeoutMs * 2,
});

const stats = {
  total: 0,
  ok: 0,
  failed: 0,
  bytes: 0,
  latencies: [],
  statuses: new Map(),
  errors: new Map(),
  perSecond: new Map(),
  pids: new Map(),
};

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function singleRequest() {
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: config.method,
        agent,
        headers: {
          "User-Agent": "excrow-bench/1.0",
          Accept: "*/*",
          ...extraHeaders,
        },
      },
      (res) => {
        let bytes = 0;
        let body = config.trackPids ? "" : null;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          // Only the first few hundred bytes matter for the pid lookup.
          if (body !== null && body.length < 512) body += chunk.toString("utf8");
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, bytes, body }));
        res.on("error", reject);
      },
    );

    req.setTimeout(config.timeoutMs, () => {
      const err = new Error("timeout");
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });

    req.on("socket", (socket) => {
      // Nagle's algorithm adds latency to small request/response pairs.
      if (typeof socket.setNoDelay === "function") socket.setNoDelay(true);
    });

    req.on("error", reject);
    if (requestBody) req.write(requestBody);
    req.end();
  });
}

const startedAt = process.hrtime.bigint();
let stopped = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared token bucket.
 *
 * Pacing per connection with its own timer does not scale: 800 connections
 * waiting on `setTimeout` every 80 ms means 10 000 timers per second inside one
 * event loop, which starves the request path and makes the generator look far
 * slower than the server is.
 *
 * A single 10 ms interval refills a shared bucket and releases queued workers,
 * so the cost of pacing is independent of the connection count.
 */
class RatePacer {
  constructor(rps) {
    this.rps = rps;
    this.tickMs = 10;
    this.tokens = 0;
    // Allow a ~100 ms burst so short scheduling hiccups do not throttle the run.
    this.capacity = Math.max(rps * 0.1, 1);
    this.waiters = [];
    this.lastTick = process.hrtime.bigint();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Deliberately NOT unref'd: while every connection is parked waiting for a
    // token there is no other ref'd handle in the loop, and an unref'd timer
    // would let Node decide the process can exit mid-run.
  }

  tick() {
    // Refill from the time that actually elapsed, not from the nominal tick
    // interval: Windows timer granularity is ~15.6 ms, so a 10 ms interval
    // would silently cap the achievable rate at ~2/3 of the target.
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - this.lastTick) / 1e6;
    this.lastTick = now;

    this.tokens = Math.min(this.capacity, this.tokens + this.rps * (elapsedMs / 1000));
    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiters.shift()();
    }
  }

  acquire() {
    if (this.waiters.length === 0 && this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop() {
    clearInterval(this.timer);
    while (this.waiters.length > 0) this.waiters.shift()();
  }
}

const pacer = config.targetRps > 0 ? new RatePacer(config.targetRps) : null;

async function connectionWorker(workerIndex, measuredStartMs, endMs) {
  // Spread the first request of every connection across one pacing interval so
  // the run does not open with an artificial thundering herd.
  if (pacer) {
    const staggerMs = (workerIndex / config.connections) * (config.connections * 1000 / pacer.rps);
    if (staggerMs > 1) await sleep(staggerMs);
  }

  const measuredStart = measuredStartMs + config.warmupSec * 1000;

  while (!stopped && Date.now() < endMs) {
    if (pacer) await pacer.acquire();
    if (stopped || Date.now() >= endMs) break;

    const requestStart = process.hrtime.bigint();
    const now = Date.now();
    const measuring = now >= measuredStart;

    let outcome = null;
    let error = null;
    try {
      outcome = await singleRequest();
    } catch (err) {
      error = err;
    }

    const latencyMs = Number(process.hrtime.bigint() - requestStart) / 1e6;

    if (measuring) {
      stats.total += 1;
      stats.latencies.push(latencyMs);

      const bucket = Math.floor((Date.now() - measuredStart) / 1000);
      bump(stats.perSecond, bucket);

      if (error) {
        stats.failed += 1;
        bump(stats.errors, error.code || error.message || "UNKNOWN");
      } else {
        bump(stats.statuses, outcome.statusCode);
        stats.bytes += outcome.bytes;

        if (outcome.body) {
          // /health answers with {"status":"ok","pid":1234,...}
          const match = /"pid"\s*:\s*(\d+)/.exec(outcome.body);
          if (match) bump(stats.pids, match[1]);
        }

        if (outcome.statusCode >= 200 && outcome.statusCode < 400) {
          stats.ok += 1;
        } else {
          stats.failed += 1;
        }
      }
    }
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function formatNumber(value) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function report(interrupted) {
  const wallSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const measuredSeconds = Math.max(
    0.001,
    Math.min(config.durationSec, wallSeconds - config.warmupSec),
  );
  const rps = stats.total / measuredSeconds;

  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const mean =
    sorted.length > 0 ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0;

  // Bucket 0 and the final bucket are usually partial seconds (the run starts
  // and ends mid-second), which would show up as jitter. Use only full seconds.
  const allBuckets = [...stats.perSecond.entries()].sort((a, b) => a[0] - b[0]);
  const buckets = (
    allBuckets.length > 3
      ? allBuckets.filter(([second]) => second >= 1 && second < config.durationSec)
      : allBuckets
  ).map(([, count]) => count);
  const bucketMin = buckets.length ? Math.min(...buckets) : 0;
  const bucketMax = buckets.length ? Math.max(...buckets) : 0;
  const bucketAvg = buckets.length ? buckets.reduce((a, b) => a + b, 0) / buckets.length : 0;
  const variance = buckets.length
    ? buckets.reduce((sum, value) => sum + (value - bucketAvg) ** 2, 0) / buckets.length
    : 0;
  const cv = bucketAvg > 0 ? (Math.sqrt(variance) / bucketAvg) * 100 : 0;

  const lines = [];
  lines.push("");
  lines.push("=".repeat(66));
  lines.push(`${interrupted ? "PARTIAL RESULT (interrupted)" : "LOAD TEST RESULT"} - ${config.label}`);
  lines.push("=".repeat(66));
  lines.push(`Target            ${config.method} ${args.url}`);
  lines.push(`Connections       ${config.connections}`);
  lines.push(`Measured window   ${measuredSeconds.toFixed(2)}s (warmup ${config.warmupSec}s excluded)`);
  if (config.targetRps > 0) lines.push(`Requested cap    ${formatNumber(config.targetRps)} req/s`);
  lines.push("");
  lines.push(`Throughput        ${formatNumber(rps)} req/s`);
  lines.push(`Requests          ${formatNumber(stats.total)} (${formatNumber(stats.ok)} ok, ${formatNumber(stats.failed)} failed)`);
  lines.push(`Response bytes    ${formatNumber(stats.bytes)} (${formatNumber(stats.bytes / measuredSeconds)} B/s)`);
  lines.push(
    `Latency           avg ${mean.toFixed(2)}ms | p50 ${percentile(sorted, 50).toFixed(2)}ms | ` +
      `p90 ${percentile(sorted, 90).toFixed(2)}ms | p99 ${percentile(sorted, 99).toFixed(2)}ms | ` +
      `p99.9 ${percentile(sorted, 99.9).toFixed(2)}ms | max ${(sorted.at(-1) || 0).toFixed(2)}ms`,
  );
  lines.push(
    `Per-second        min ${bucketMin} | avg ${bucketAvg.toFixed(1)} | max ${bucketMax} | jitter(cv) ${cv.toFixed(1)}%`,
  );

  lines.push("");
  lines.push("Status codes:");
  if (stats.statuses.size === 0) lines.push("  (none)");
  for (const [code, count] of [...stats.statuses.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  ${code}: ${formatNumber(count)}`);
  }

  if (stats.errors.size > 0) {
    lines.push("");
    lines.push("Transport errors:");
    for (const [code, count] of [...stats.errors.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${code}: ${formatNumber(count)}`);
    }
  }

  if (config.trackPids) {
    lines.push("");
    lines.push(`Worker processes used: ${stats.pids.size}`);
    const total = [...stats.pids.values()].reduce((sum, value) => sum + value, 0);
    for (const [pid, count] of [...stats.pids.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`  pid ${pid}: ${formatNumber(count)} (${((count / total) * 100).toFixed(1)}%)`);
    }
    if (stats.pids.size === 1) {
      lines.push(
        "  NOTE: a single worker answered everything. With WEB_CONCURRENCY>1 that means the",
      );
      lines.push(
        "        OS is not spreading connections (Windows cluster scheduling), so your real",
      );
      lines.push("        ceiling is one process, not the whole cluster.");
    }
  }

  lines.push("");
  const verdict = stats.failed === 0 && rps > 0;

  // Closed-loop generators can silently under-deliver: with one in-flight
  // request per socket, throughput is capped by connections / latency.
  if (config.targetRps > 0 && rps < config.targetRps * 0.95) {
    const p99ms = percentile(sorted, 99);
    const latencyMs = Math.max(p99ms, mean);
    const closedLoopCeiling = config.connections / (latencyMs / 1000);
    lines.push("");
    lines.push(
      `WARNING: asked for ${formatNumber(config.targetRps)} req/s but achieved ` +
        `${formatNumber(rps)} req/s (${((rps / config.targetRps) * 100).toFixed(1)}% of target).`,
    );

    if (closedLoopCeiling < config.targetRps) {
      const needed = Math.ceil(config.targetRps * (latencyMs / 1000));
      lines.push(
        `         One in-flight request per socket means ${config.connections} connections at ` +
          `${latencyMs.toFixed(1)}ms p99 cap out near ${formatNumber(closedLoopCeiling)} req/s.`,
      );
      lines.push(
        `         Raise --connections to ${needed} or more to actually reach the target.`,
      );
    } else {
      lines.push(
        `         Latency is only ${latencyMs.toFixed(1)}ms, so the server is not the limit - ` +
          `the generator itself is.`,
      );
      lines.push(
        `         Run several generator processes in parallel (see docs/BENCHMARK.md) or use k6.`,
      );
    }
  }

  lines.push("");
  lines.push(
    verdict
      ? `PASS: every request succeeded.`
      : `FAIL: ${formatNumber(stats.failed)} request(s) did not return 2xx/3xx.`,
  );
  lines.push("=".repeat(66));
  console.log(lines.join("\n"));
}

process.on("SIGINT", () => {
  if (stopped) process.exit(1);
  stopped = true;
  console.log("\nInterrupted - collecting results...");
});

const startMs = Date.now();

let progressTimer = null;
if (config.progress) {
  progressTimer = setInterval(() => {
    const elapsed = (Date.now() - startMs) / 1000;
    const phase = elapsed < config.warmupSec ? "warmup" : "measuring";
    const rps = stats.total / Math.max(1, elapsed - config.warmupSec);
    process.stdout.write(
      `\r[${elapsed.toFixed(0)}s] ${phase} | ${formatNumber(stats.total)} req | ${formatNumber(rps)} req/s | ` +
        `${formatNumber(stats.failed)} failed   `,
    );
  }, 1000);
  progressTimer.unref?.();
}

console.log(
  `Starting ${config.label}: ${config.connections} connections, ${config.warmupSec}s warmup, ` +
    `${config.durationSec}s measured` +
    (config.targetRps > 0 ? `, capped at ${formatNumber(config.targetRps)} req/s` : ""),
);

const workers = [];
const runEndMs = startMs + (config.warmupSec + config.durationSec) * 1000;
for (let i = 0; i < config.connections; i += 1) {
  workers.push(connectionWorker(i, startMs, runEndMs));
}

await Promise.all(workers);
if (progressTimer) clearInterval(progressTimer);
pacer?.stop();
process.stdout.write("\r".padEnd(120) + "\r");
agent.destroy();

report(stopped);

// exitCode (not process.exit) so buffered stdout is never truncated.
if (!config.allowErrors && stats.failed > 0) process.exitCode = 1;
