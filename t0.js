// tests/wallet.test.js
import dotenv from "dotenv";
dotenv.config();

import * as walletService from "./src/services/wallet.service.js";
import { getDB, connectDB } from "./src/config/db.js";

async function run() {
  try {
    // Connect to DB
    await connectDB();

    // Step 1: Create a new master wallet
    const { mnemonic, xpub } = await walletService.createMasterFromMnemonic({
      label: "escrow-deposits",
    });
    console.log("\n✅ Generated mnemonic:", mnemonic);
    console.log("✅ Generated XPUB:", xpub);

    // Step 2: Import XPUB (if not already imported)
    const imported = await walletService.importXpub({ xpub, label: "escrow-deposits" });
    console.log("\n✅ Imported wallet doc:", imported);

    // Step 3: Allocate 10 deposit addresses
    const allocatedAddresses = [];
    for (let i = 0; i < 10; i++) {
      const allocated = await walletService.allocateAddressFor({
        walletLabel: "escrow-deposits",
        type: "transaction",
        id: i + 1,
      });
      allocatedAddresses.push(allocated);
      console.log(`🔹 Allocated address [index=${allocated.index}]: ${allocated.address}`);
    }

    // Step 4: Print the wallet at index 2
    const walletIndex2 = allocatedAddresses.find(a => a.index === 2);
    console.log("\n🎯 Wallet at index 2:", walletIndex2);

    // Step 5: Validate the address at index 2
    const isValid = walletService.validateAddress(walletIndex2.address);
    console.log("✅ Address valid?", isValid);

    // Step 6: Pre-derive 5 addresses starting at index 0
    const batch = await walletService.prederiveAddresses(xpub, 0, 5);
    console.log("\n🔹 Prederived batch of addresses:", batch);

  } catch (err) {
    console.error("❌ Test run failed:", err);
  }
}

run();