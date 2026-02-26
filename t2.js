// test-transaction-spv.js
// Test runner for the SPV watcher in transaction.service.js

import { startSpvWatcher } from "./src/services/transaction.service.js";

async function main() {
  console.log("🚀 Starting SPV watcher test...");

  // Addresses you want to track — you can edit these
  const testAddresses = [
    "tb1q30d9ac20687a670kxjchzm3rdzl3mprx5q4smd",
    "tb1qt8lwsj7fyg7ul37jvc2zsaszv6m90g6d0fwjnt",
  ];

  // Start watcher (your service must accept addresses)
  await startSpvWatcher(testAddresses);

  console.log("🔍 SPV watcher is now running...");
  console.log("It will continue running and print incoming transactions.");

  // Do not exit — keep the Node process alive
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
