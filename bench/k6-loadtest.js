// k6 load test for excrow-backend.
//
// k6 is the right tool for the 10k req/s target: it runs isolated VUs in Go,
// so the load generator itself will not be the bottleneck the way a
// single-process Node client can be.
//
// Install (Windows):  winget install k6 --source winget
// Install (macOS):    brew install k6
// Install (Linux):    https://grafana.com/docs/k6/latest/set-up/install-k6/
//
// Run:
//   k6 run bench/k6-loadtest.js                                  # ramp to 10k
//   MODE=steady RPS=10000 DURATION=60s k6 run bench/k6-loadtest.js
//   ENDPOINT=http://localhost:3001/api/platform/status k6 run bench/k6-loadtest.js
//
// Environment variables:
//   ENDPOINT   target URL            (default http://localhost:3001/health)
//   MODE       "ramp" | "steady"     (default ramp: finds your ceiling)
//   RPS        steady-mode rate      (default 10000)
//   DURATION   steady-mode duration  (default 60s)
//   START_RPS  ramp start rate       (default 500)
//   MAX_RPS    ramp top rate         (default 15000)
//   P95_MS     p95 latency budget    (default 50)
//   P99_MS     p99 latency budget    (default 150)
//   BODY       JSON body for POST/PUT tests

import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

// A benchmark that hides its own error rate is worthless, so every response is
// broken down by status code and by k6 error code (status 0 = no HTTP response
// at all, e.g. a connection reset or a timeout).
const responseStatus = new Counter("response_status");
const responseErrorCode = new Counter("response_error_code");

let loggedSamples = 0;

const ENDPOINT = __ENV.ENDPOINT || "http://localhost:3001/health";
const MODE = (__ENV.MODE || "ramp").toLowerCase();
// k6 requires int64 stage targets/rates, so never let a fractional value
// through: `MAX_RPS * (2/3)` silently produced 133.33... and made the whole
// scenario fail to initialise.
const asInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
};

const TARGET_RPS = asInt(__ENV.RPS, 10000);
const DURATION = __ENV.DURATION || "60s";
const START_RPS = asInt(__ENV.START_RPS, 500);
const MAX_RPS = asInt(__ENV.MAX_RPS, 15000);
const P95_MS = asInt(__ENV.P95_MS, 50);
const P99_MS = asInt(__ENV.P99_MS, 150);
const BODY = __ENV.BODY || null;

const METHOD = BODY ? "POST" : "GET";

// VUs needed for a target rate = target_rps x expected latency (Little's law).
// Assume a generous 50 ms service time, then double it for safety.
const vusFor = (rps) => Math.max(100, Math.ceil((rps * 0.05) * 2));

const scenarios =
  MODE === "steady"
    ? {
        // Ramping rather than jumping straight to the target matters on
        // Windows: a constant-arrival-rate scenario dials every pre-allocated
        // VU at once, and a burst of ~1000 simultaneous TCP connects overflows
        // the accept queue, which the OS reports as "dial: connection refused"
        // (error_code 1212) - failures that have nothing to do with the app.
        // Ramping establishes connections gradually, then holds the target.
        steady: {
          executor: "ramping-arrival-rate",
          startRate: Math.max(1, Math.round(TARGET_RPS * 0.1)),
          timeUnit: "1s",
          stages: [
            { target: Math.round(TARGET_RPS * 0.25), duration: "5s" },
            { target: TARGET_RPS, duration: "10s" },
            { target: TARGET_RPS, duration: DURATION },
          ],
          preAllocatedVUs: vusFor(TARGET_RPS),
          maxVUs: vusFor(TARGET_RPS) * 3,
          gracefulStop: "10s",
        },
      }
    : {
        // Step upward until the pass/fail thresholds break: that step is your
        // real ceiling, and the last fully-green step is your safe capacity.
        ramp: {
          executor: "ramping-arrival-rate",
          startRate: START_RPS,
          timeUnit: "1s",
          stages: [
            { target: Math.round(MAX_RPS * 0.25), duration: "30s" },
            { target: Math.round(MAX_RPS * 0.5), duration: "30s" },
            { target: Math.round(MAX_RPS * (2 / 3)), duration: "30s" },
            { target: MAX_RPS, duration: "30s" },
            { target: MAX_RPS, duration: "60s" }, // hold at peak
            { target: 0, duration: "15s" },      // ramp down
          ],
          preAllocatedVUs: vusFor(MAX_RPS),
          maxVUs: vusFor(MAX_RPS) * 3,
          gracefulStop: "15s",
        },
      };

export const options = {
  scenarios,
  discardResponseBodies: true, // measuring the server, not the client
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "p(99.9)", "max"],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${P95_MS}`, `p(99)<${P99_MS}`],
  },
};

export default function () {
  const params = {
    headers: { "Content-Type": "application/json" },
    tags: { endpoint: ENDPOINT },
  };

  const res =
    METHOD === "GET"
      ? http.get(ENDPOINT, params)
      : http.request(METHOD, ENDPOINT, BODY, params);

  responseStatus.add(1, { status: String(res.status) });
  if (res.error_code) {
    responseErrorCode.add(1, { code: String(res.error_code) });
  }

  if (res.status !== 200 && loggedSamples < 3) {
    loggedSamples += 1;
    console.log(
      `non-200 sample: status=${res.status} error=${res.error || "none"} ` +
        `error_code=${res.error_code || 0} duration=${res.timings.duration}ms`,
    );
  }

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}
