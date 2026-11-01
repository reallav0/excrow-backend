// src/cluster.js
//
// Multi-process entrypoint: `node src/cluster.js` (or `npm run start:cluster`).
//
// A single Node process is limited to one CPU core, which caps a plain Express
// API somewhere around 5-15k req/s per core depending on the handler. Forking
// one worker per core is how you clear 10k req/s with headroom on real
// hardware.
//
// Configuration:
//   WEB_CONCURRENCY=0   -> one worker per available CPU core (default)
//   WEB_CONCURRENCY=1   -> single worker, same topology as `npm start`
//   WEB_CONCURRENCY=8   -> exactly 8 workers
//
// IMPORTANT: Socket.IO rooms are per-process. With more than one worker,
// broadcast messages (chat, live feed, deposit notifications) only reach the
// clients connected to the same worker. Add a Redis adapter
// (@socket.io/redis-adapter) before running multiple workers in production.
// HTTP REST endpoints are unaffected and are what you benchmark.

import cluster from "node:cluster";
import os from "node:os";
import process from "node:process";

const MAX_RESTARTS_IN_WINDOW = Number(process.env.CLUSTER_MAX_RESTARTS) || 10;
const RESTART_WINDOW_MS = 60_000;

// Exit code 78 (EX_CONFIG) means "this will never work by retrying" - port in
// use, missing JWT_SECRET, privileged port. Restarting such a worker just hides
// the real error behind a crash loop.
const EXIT_CONFIG_ERROR = 78;

function resolveWorkerCount() {
  const configured = Number(process.env.WEB_CONCURRENCY);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  // 0 / unset / invalid -> one worker per core.
  return typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length;
}

const WORKER_COUNT = resolveWorkerCount();

if (cluster.isPrimary) {
  console.log(
    `[Cluster] primary ${process.pid} starting ${WORKER_COUNT} worker(s) on ` +
      `port ${process.env.PORT || 3001}`,
  );

  let restarts = [];
  let shuttingDown = false;

  /**
   * Kill every worker and only exit once they are actually gone.
   * Exiting immediately after `.kill()` can leave orphan workers behind that
   * keep holding the listening port.
   */
  const stopCluster = (exitCode, reason) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const workers = Object.values(cluster.workers || {});
    console.log(`[Cluster] shutting down (${reason}): stopping ${workers.length} worker(s)`);

    if (workers.length === 0) {
      process.exit(exitCode);
    }

    let remaining = workers.length;
    const onExit = () => {
      remaining -= 1;
      if (remaining <= 0) process.exit(exitCode);
    };

    for (const worker of workers) {
      worker.once("exit", onExit);
      try {
        worker.kill();
      } catch {
        // Already gone - the exit handler still fires.
      }
    }

    // Never hang forever waiting on a stuck worker.
    setTimeout(() => process.exit(exitCode), 10_000).unref?.();
  };

  const spawnWorker = () => {
    const worker = cluster.fork();
    worker.on("exit", (code, signal) => {
      if (worker.exitedAfterDisconnect) {
        // Intentional shutdown (SIGTERM/SIGINT) - do not restart.
        return;
      }

      if (code === EXIT_CONFIG_ERROR) {
        // Every worker will fail the same way - stop instead of crash-looping.
        stopCluster(1, `worker ${worker.process.pid} hit a configuration error`);
        return;
      }

      const now = Date.now();
      restarts = restarts.filter((ts) => now - ts < RESTART_WINDOW_MS);
      restarts.push(now);

      if (restarts.length > MAX_RESTARTS_IN_WINDOW) {
        console.error(
          `[Cluster] ${restarts.length} worker crashes in under ` +
            `${RESTART_WINDOW_MS / 1000}s - giving up. Fix the underlying error first.`,
        );
        // Tear down the whole cluster so the orchestrator restarts the container.
        stopCluster(1, "too many worker crashes");
        return;
      }

      console.error(
        `[Cluster] worker ${worker.process.pid} died (code=${code}, signal=${signal}), restarting`,
      );
      spawnWorker();
    });
    return worker;
  };

  for (let i = 0; i < WORKER_COUNT; i += 1) {
    spawnWorker();
  }

  process.on("SIGTERM", () => {
    stopCluster(0, "SIGTERM");
  });

  process.on("SIGINT", () => {
    stopCluster(0, "SIGINT");
  });
} else {
  // Worker: run the normal server. Every worker shares the listening port.
  await import("./index.js");
}
