// src/tests/test-wallet.js

import {
  createMasterFromMnemonic,
  prederiveAddresses,
  allocateAddressFor,
  getWallet
} from "./src/services/wallet.service.js";
import { getDB, connectDB } from "./src/config/db.js";
async function runTest() {
  await connectDB()
  console.log("========== WALLET TEST START ==========");

  let xpub = 'xpub6Cc3Mwtwx8iim6sHhNhdFeKGnnr2y2iJSbfV4JsQCQSZVn9F9uTmg7fatiK21mzGxfLGJXUkgKvTLEkPNAtnkaBFj1EAE1y6h42Hnx8jK5M'
  // 2️⃣ PRE-DERIVE 10 ADDRESSES (not stored in DB)
  console.log("\n🔹 Pre-deriving 10 addresses...");
  const preview = await prederiveAddresses(xpub, 0, 10);

  console.log("\n🟦 PREVIEW ADDRESSES (0–9):");
  preview.forEach((a) => console.log(`Index ${a.index}: ${a.address}`));

  // 3️⃣ OFFICIALLY ALLOCATE 10 ADDRESSES (stored in DB)
  console.log("\n🔹 Allocating 10 deposit addresses via DB...");
  for (let i = 0; i < 10; i++) {
    const addr = await allocateAddressFor({
      walletLabel: "escrow-deposits",
      type: "main",
      id: i
    });
    console.log(`Allocated index ${addr.index}: ${addr.address}`);
  }

  // 4️⃣ CONFIRM THE WALLET STATE FROM DB
  console.log("\n🔹 Fetching wallet from DB...");
  const wallet = await getWallet({ label: "test-wallet" });
  console.log("\n🟢 Wallet document from DB:");
  console.log(wallet);

  console.log("\n========== WALLET TEST COMPLETE ==========\n");
}

runTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ TEST FAILED:", err);
    process.exit(1);
  });
