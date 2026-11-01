#!/usr/bin/env node
//
// Launcher for the k6 scenarios.
//
// Why this exists: k6 is a standalone Go binary, not an npm dependency, so it
// is not installed by `npm ci`. On Windows, winget adds k6 to the *machine*
// PATH, which a terminal that is already open will not see - that is how you
// end up with "'k6' is not recognized as an internal or external command".
//
// This wrapper resolves k6 from PATH or from the usual install locations and
// prints actionable instructions when it is genuinely missing.
//
// Usage: node bench/run-k6.mjs run bench/k6-loadtest.js [k6 flags...]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CANDIDATE_DIRS = [
  // Windows (winget / manual MSI install)
  "C:\\Program Files\\k6",
  "C:\\Program Files (x86)\\k6",
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")
    : null,
  // macOS (brew) and Linux
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  process.env.HOME ? path.join(process.env.HOME, "k6") : null,
].filter(Boolean);

const EXTENSIONS = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

function resolveK6() {
  // 1. Real PATH lookup.
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);

  for (const dir of [...pathDirs, ...CANDIDATE_DIRS]) {
    for (const ext of EXTENSIONS) {
      const candidate = path.join(dir, `k6${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not there - keep looking
      }
    }
  }

  return null;
}

function printInstallHelp() {
  console.error("");
  console.error("k6 was not found. k6 is a standalone binary, not an npm package,");
  console.error("so `npm ci` does not install it.");
  console.error("");
  console.error("Install it with:");
  console.error("  Windows:  winget install GrafanaLabs.k6");
  console.error("  macOS:    brew install k6");
  console.error("  Debian:   sudo apt-get install k6   (see grafana.com/docs/k6 for other distros)");
  console.error("  Docker:   docker run --rm -i --network host grafana/k6 run - < bench/k6-loadtest.js");
  console.error("");
  console.error("No k6? Two zero-install alternatives are already in this repo:");
  console.error("  npm run bench       # uncapped, finds the ceiling");
  console.error("  npm run bench:10k   # paced at 10 000 req/s");
  console.error("");
}

const k6Path = resolveK6();

if (!k6Path) {
  printInstallHelp();
  process.exit(1);
}

const k6Args = process.argv.slice(2);

// Node refuses to spawn .cmd/.bat shims without a shell (CVE-2024-27980), so
// fall back to shell execution for those wrappers only.
const needsShell = /\.(cmd|bat)$/i.test(k6Path);

const result = spawnSync(k6Path, k6Args, {
  stdio: "inherit",
  shell: needsShell,
});

if (result.error) {
  console.error(`Failed to start k6 at ${k6Path}: ${result.error.message}`);
  printInstallHelp();
  process.exit(1);
}

process.exit(result.status ?? 1);
