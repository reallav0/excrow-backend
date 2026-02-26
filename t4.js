import axios from "axios";

const url = "https://go.getblock.io/e269e9349a1f4a1c9ea72a9c6ad3d1af";

const TRACKED_ADDRESSES = new Set([
  "tb1q30d9ac20687a670kxjchzm3rdzl3mprx5q4smd",
    "tb1qt8lwsj7fyg7ul37jvc2zsaszv6m90g6d0fwjnt",
]);

const POLL_INTERVAL = 15000; // 15s (safe for BTC)

async function rpc(method, params = []) {
  const { data } = await axios.post(url, {
    jsonrpc: "2.0",
    method,
    params,
    id: "getblock.io"
  }, {
    headers: {
      "Content-Type": "application/json"
    }
  });

  if (data.error) throw new Error(data.error.message);
  return data.result;
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

let lastProcessedHeight = null;

async function watch() {
  while (true) {

    try {
      const info = await rpc("getblockchaininfo");

      // first run
      if (lastProcessedHeight === null) {
        lastProcessedHeight = info.blocks - 1;
        console.log("Starting from height:", lastProcessedHeight);
      }

      // new blocks exist
      while (lastProcessedHeight < info.blocks) {
        lastProcessedHeight++;

        const hash = await rpc("getblockhash", [lastProcessedHeight]);
        const block = await rpc("getblock", [hash, 2]);

        console.log(`\n🧱 Scanning block ${block.height}`);
        console.log('Checking')
        for (const tx of block.tx) {
            console.log(`Looking at each tx ${tx}`)
          // 📥 deposits
          for (const out of tx.vout) {
            const addrs = out.scriptPubKey.addresses || [];

            for (const addr of addrs) {
              if (TRACKED_ADDRESSES.has(addr)) {
                console.log("📥 Deposit detected");
                console.log("Address:", addr);
                console.log("Amount:", out.value, "BTC");
                console.log("TXID:", tx.txid);
                console.log("Block:", block.height);
                console.log("-------------------------");
              }
            }
          }

          // 📤 spends (placeholder)
          for (const vin of tx.vin) {
            if (!vin.txid) continue;
            // here you would lookup UTXOs in DB
          }
        }
      }

      await sleep(POLL_INTERVAL);

    } catch (err) {
      console.error("Watcher error:", err.message);
      await sleep(10000);
    }
  }
}

watch();
