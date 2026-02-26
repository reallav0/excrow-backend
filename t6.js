import "dotenv/config";
import { connectDB } from "./src/config/db.js";
import {
  initMasterWallet,
  allocateDepositAddress,
  validateAddress
} from "./src/services/ltcwallet.service.js";

async function run() {
  console.log("🔌 Connecting to database...");
  await connectDB();

  console.log("🚀 Initializing Litecoin master wallet...");
  const wallet = await initMasterWallet();
  console.log("Master wallet:", wallet);

  console.log("\n📦 Allocating Litecoin deposit addresses...");

  const addr1 = await allocateDepositAddress({ id: "escrow_001" });
  console.log("Address 1:", addr1);

  const addr2 = await allocateDepositAddress({ id: "escrow_002" });
  console.log("Address 2:", addr2);

  console.log("\n🔍 Validating addresses...");
  console.log(addr1.address, "=>", validateAddress(addr1.address));
  console.log(addr2.address, "=>", validateAddress(addr2.address));

  console.log("\n✅ Litecoin wallet service test completed successfully");
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Litecoin wallet test failed:", err);
  process.exit(1);
});
