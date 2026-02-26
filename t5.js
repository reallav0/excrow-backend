import "dotenv/config";
import { getDB, connectDB } from "./src/config/db.js";
import {
  initMasterWallet,
  allocateDepositAddress,
  validateAddress
} from "./src/services/wallet.service.js";

async function run() {
  console.log("🔌 Connecting to DB...");
  await connectDB();

  console.log("🚀 Initializing master wallet...");
  const wallet = await initMasterWallet();
  console.log("Wallet:", wallet);

  console.log("📦 Allocating deposit address...");
  const addr1 = await allocateDepositAddress({ id: "order_001" });
  console.log("Address 1:", addr1);

  const addr2 = await allocateDepositAddress({ id: "order_002" });
  console.log("Address 2:", addr2);

  console.log("🔍 Validating addresses...");
  console.log(addr1.address, "=>", validateAddress(addr1.address));
  console.log(addr2.address, "=>", validateAddress(addr2.address));

  console.log("✅ Wallet service test completed");
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
