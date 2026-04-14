/**
 * BTC Transaction Service
 *
 * Builds, signs and broadcasts a Bitcoin transaction from an escrow deposit
 * address to a destination address.
 *
 * Input:  escrowId  – the assignedId on the address doc (e.g. "escrow_001")
 *         toAddress – destination Bitcoin address
 *
 * Flow:
 *   1. Look up address doc by assignedId in addresses_btc
 *   2. Validate deposit exists, not already spent
 *   3. Resolve vout from the deposit tx via RPC (getrawtransaction)
 *   4. Derive scriptPubKey from the address
 *   5. Estimate fee via RPC (estimatesmartfee)
 *   6. Build PSBT → sign → finalise
 *   7. Dry-run via testmempoolaccept
 *   8. Broadcast raw tx via RPC (sendrawtransaction)
 *   9. Mark deposit spent + record withdrawal on address doc
 */

import * as ecc from "tiny-secp256k1";
import crypto from "crypto";
import { BIP32Factory } from "bip32";
import * as bitcoin from "bitcoinjs-lib";
import { getDB } from "../../config/db.js";
import { NETWORK, validateAddress } from "../wallet/btc.service.js";
import { btcRpc } from "../rpc.service.js";

const bip32 = BIP32Factory(ecc);

const ADDRESSES_COLL = "addresses_btc";
const BROADCAST_COLL = "broadcast_btc";

/* ─── constants ─── */
const DUST_LIMIT = 546;

/* ─── helpers ─── */

function toSats(btc) {
  return Math.round(btc * 1e8);
}

function decryptXprvPayload(payload, fallbackSalt) {
  const passphrase = process.env.XPRIV_ENCRYPTION_KEY;
  if (!passphrase) {
    throw new Error("XPRIV_ENCRYPTION_KEY not set");
  }

  const salt = payload?.salt || fallbackSalt || process.env.XPRIV_ENCRYPTION_SALT;
  if (!salt) {
    throw new Error("XPRIV_ENCRYPTION_SALT not set");
  }

  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const key = crypto.scryptSync(passphrase, salt, 32);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function extractXprvFromBroadcastDoc(doc) {
  if (!doc) {
    throw new Error("No broadcast BTC signing record found");
  }

  if (typeof doc.xprv === "string" && doc.xprv.length > 0) {
    return doc.xprv;
  }

  if (typeof doc.xpriv === "string" && doc.xpriv.length > 0) {
    return doc.xpriv;
  }

  const payloadCandidates = [doc.xprvEncrypted, doc.encryptedXprv, doc.xprv, doc.xpriv, doc];
  const encrypted = payloadCandidates.find(
    (v) => v && typeof v === "object" && v.iv && v.authTag && v.ciphertext
  );

  if (!encrypted) {
    throw new Error("broadcast_btc record missing xprv/xpriv payload");
  }

  const algo = (encrypted.algorithm || "aes-256-gcm").toLowerCase();
  if (algo !== "aes-256-gcm") {
    throw new Error(`Unsupported xprv encryption algorithm: ${encrypted.algorithm}`);
  }

  return decryptXprvPayload(encrypted, doc.salt);
}

async function getSigningNode(db, index, derivationPath) {
  const doc = await db.collection(BROADCAST_COLL).findOne(
    {
      $or: [
        { active: true },
        { xprv: { $exists: true } },
        { xpriv: { $exists: true } },
        { xprvEncrypted: { $exists: true } },
        { encryptedXprv: { $exists: true } },
        { algorithm: { $exists: true }, iv: { $exists: true }, authTag: { $exists: true }, ciphertext: { $exists: true } },
      ],
    },
    {
      sort: { active: -1, updatedAt: -1, createdAt: -1 },
    }
  );

  const accountXprv = extractXprvFromBroadcastDoc(doc);
  const accountNode = bip32.fromBase58(accountXprv, NETWORK);

  if (Number.isInteger(index)) {
    return accountNode.derive(0).derive(index);
  }

  const pathMatch = typeof derivationPath === "string"
    ? derivationPath.match(/\/(\d+)\/(\d+)$/)
    : null;

  if (pathMatch) {
    const change = Number(pathMatch[1]);
    const idx = Number(pathMatch[2]);
    return accountNode.derive(change).derive(idx);
  }

  throw new Error("Could not determine child derivation index for signing key");
}

/**
 * Estimate fee in satoshis for a 1-in / 1-out P2WPKH transaction.
 * Falls back to a safe default if the node cannot estimate.
 */
async function estimateFee(confTarget = 6) {
  try {
    const result = await btcRpc("estimatesmartfee", [confTarget]);

    if (result?.feerate) {
      const satPerKb = toSats(result.feerate);
      const satPerVbyte = Math.ceil(satPerKb / 1000);

      // Native-segwit 1-in 1-out ≈ 110 vBytes
      const estimatedVbytes = 110;
      return Math.max(satPerVbyte * estimatedVbytes, 200);
    }
  } catch {
    // node not ready / not enough data
  }

  // Safe fallback
  return 300;
}

/**
 * Resolve the vout index for our address from the deposit txid.
 * Fetches the raw transaction via RPC and finds the output paying to `address`.
 */
async function resolveVout(txid, address) {
  const rawTx = await btcRpc("getrawtransaction", [txid, true]);

  for (const out of rawTx.vout) {
    const outAddress =
      out.scriptPubKey?.address ||
      (out.scriptPubKey?.addresses && out.scriptPubKey.addresses[0]);

    if (outAddress === address) {
      return { vout: out.n, scriptPubKeyHex: out.scriptPubKey.hex };
    }
  }

  throw new Error(`Could not find vout for address ${address} in tx ${txid}`);
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC  –  sendBtcTransaction
   ═══════════════════════════════════════════════════════════ */

/**
 * Build, sign and broadcast a BTC transaction for an escrow release / refund.
 *
 * @param {object} opts
 * @param {string} opts.escrowId   – assignedId on the address doc
 * @param {string} opts.toAddress  – destination Bitcoin address
 * @returns {Promise<{ txid: string, fee: number, amount: number }>}
 */
export async function sendBtcTransaction({ escrowId, toAddress }) {
  /* ── validate destination ── */
  if (!validateAddress(toAddress)) {
    throw new Error("Invalid destination BTC address");
  }

  const db = getDB();

  /* ── 1. look up address doc by assignedId ── */
  const addressDoc = await db.collection(ADDRESSES_COLL).findOne({
    assignedId: escrowId,
  });

  if (!addressDoc) throw new Error(`Address doc not found for assignedId "${escrowId}"`);

  const { address, index, deposit } = addressDoc;

  /* ── 2. validate deposit exists and is not already spent ── */
  if (!deposit || !deposit.txid) {
    throw new Error("No deposit found on this address");
  }

  if (deposit.spent) {
    throw new Error("Deposit has already been spent");
  }

  if (deposit.locked) {
    throw new Error("Deposit is currently locked by another operation");
  }

  /* ── 3. lock the deposit (atomic) ── */
  const lockResult = await db.collection(ADDRESSES_COLL).updateOne(
    {
      _id: addressDoc._id,
      "deposit.txid": deposit.txid,
      "deposit.locked": { $ne: true },
      "deposit.spent": { $ne: true },
    },
    {
      $set: {
        "deposit.locked": true,
        "deposit.lockedAt": new Date(),
        "deposit.lockedBy": escrowId,
      },
    }
  );

  if (lockResult.modifiedCount === 0) {
    throw new Error("Failed to lock deposit — already locked or spent");
  }

  try {
    /* ── 4. resolve vout + scriptPubKey from the network ── */
    const { vout, scriptPubKeyHex } = await resolveVout(deposit.txid, address);

    // Also derive scriptPubKey locally as fallback
    const localScript = bitcoin.address.toOutputScript(address, NETWORK);

    const witnessScript = scriptPubKeyHex
      ? Buffer.from(scriptPubKeyHex, "hex")
      : localScript;

    const valueSats = toSats(deposit.value);

    /* ── 5. estimate fee ── */
    const feeSats = await estimateFee(6);
    const sendSats = valueSats - feeSats;

    if (sendSats <= DUST_LIMIT) {
      throw new Error(
        `Insufficient balance after fee: ${valueSats} sats available, ` +
        `${feeSats} sats fee, only ${sendSats} sats remaining`
      );
    }

    /* ── 6. derive signing key from stored xprv ── */
    const child = await getSigningNode(db, index, addressDoc.derivationPath);

    /* ── 7. build PSBT ── */
    const psbt = new bitcoin.Psbt({ network: NETWORK });

    psbt.addInput({
      hash: deposit.txid,
      index: vout,
      witnessUtxo: {
        script: new Uint8Array(witnessScript),
        value: BigInt(valueSats),
      },
    });

    psbt.addOutput({ address: toAddress, value: BigInt(sendSats) });

    /* ── 8. sign ── */
    psbt.signInput(0, child);
    psbt.finalizeAllInputs();

    const rawTx = psbt.extractTransaction().toHex();

    /* ── 9. dry-run via testmempoolaccept ── */
    try {
      const [acceptance] = await btcRpc("testmempoolaccept", [[rawTx]]);
      if (!acceptance.allowed) {
        throw new Error(acceptance["reject-reason"] || "Transaction rejected by mempool");
      }
    } catch (err) {
      if (err.code) {
        throw new Error(`Transaction rejected (pre-broadcast): ${err.message}`);
      }
      console.warn("[BTC-TX] testmempoolaccept unavailable, skipping dry-run");
    }

    /* ── 10. broadcast ── */
    const broadcastTxid = await btcRpc("sendrawtransaction", [rawTx]);

    /* ── 11. mark deposit spent + record withdrawal ── */
    await db.collection(ADDRESSES_COLL).updateOne(
      { _id: addressDoc._id },
      {
        $set: {
          "deposit.spent": true,
          "deposit.spentAt": new Date(),
          "deposit.spentTxid": broadcastTxid,
          "deposit.locked": false,
          updatedAt: new Date(),
        },
        $push: {
          withdraw: {
            escrowId,
            txid: broadcastTxid,
            toAddress,
            amount: sendSats / 1e8,
            fee: feeSats / 1e8,
            vout,
            createdAt: new Date(),
          },
        },
      }
    );

    console.log(
      `[BTC-TX] Sent ${sendSats} sats from ${address} → ${toAddress} | txid: ${broadcastTxid}`
    );

    return {
      txid: broadcastTxid,
      fee: feeSats / 1e8,
      amount: sendSats / 1e8,
    };

  } catch (err) {
    /* ── unlock deposit on any failure ── */
    await db.collection(ADDRESSES_COLL).updateOne(
      { _id: addressDoc._id },
      {
        $set: {
          "deposit.locked": false,
          "deposit.lockedAt": null,
          "deposit.lockedBy": null,
        },
      }
    );
    throw err;
  }
}
