/**
 * RPC Service  –  GetBlock.io JSON-RPC client
 *
 * Connects to Bitcoin and Litecoin full nodes via GetBlock's hosted RPC.
 * URL format:  https://go.getblock.io/<ACCESS_TOKEN>/
 *
 * Env variables required:
 *   GETBLOCK_BTC_URL  – e.g. https://go.getblock.io/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/
 *   GETBLOCK_LTC_URL  – e.g. https://go.getblock.io/yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy/
 *
 * Supported methods used by this project:
 *   sendrawtransaction   – broadcast a signed transaction
 *   estimatesmartfee     – fee estimation per confirmation target
 *   testmempoolaccept    – dry-run validation before broadcast
 *   getrawtransaction    – look up a transaction by txid
 *   getrawmempool        – check mempool for pending transactions
 *   getblockcount        – current chain height
 */

import axios from "axios";

/* ───────────────────────── core RPC caller ───────────────────────── */

async function jsonRpc(url, method, params = []) {
  if (!url) {
    throw new Error(`RPC URL not configured for method ${method}`);
  }

  const { data } = await axios.post(
    url,
    {
      jsonrpc: "2.0",
      method,
      params,
      id: "getblock.io",
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30_000,
    }
  );

  if (data.error) {
    const err = new Error(`RPC ${method} failed: ${data.error.message}`);
    err.code = data.error.code;
    throw err;
  }

  return data.result;
}

/* ───────────────────────── BTC ───────────────────────── */

/**
 * Call any JSON-RPC method on the BTC node.
 * @param {string} method
 * @param {any[]}  params
 */
export function btcRpc(method, params = []) {
  const url = process.env.GETBLOCK_BTC_URL;
  return jsonRpc(url, method, params);
}

/* ───────────────────────── LTC ───────────────────────── */

/**
 * Call any JSON-RPC method on the LTC node.
 * @param {string} method
 * @param {any[]}  params
 */
export function ltcRpc(method, params = []) {
  const url = process.env.GETBLOCK_LTC_URL;
  return jsonRpc(url, method, params);
}
