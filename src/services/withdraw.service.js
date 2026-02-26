import bip39 from "bip39";
import { BIP32Factory } from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { getDB } from "../config/db.js";
import { NETWORK } from "./wallet.service.js";
import { ltcRpc } from "./rpc.service.js";
import { lockUtxo, markUtxoSpent } from "./wallet.service.js";

const bip32 = BIP32Factory(ecc);

const ADDRESSES_COLL = "addresses_ltc";

function toSatoshi(ltc) {
  return Math.round(ltc * 1e8);
}

export async function sendLitecoin({
  escrowId,
  toAddress,
  feeSats = 1000
}) {
  const db = getDB();

  // 1️⃣ Find address by escrow id
  const addressDoc = await db.collection(ADDRESSES_COLL).findOne({
    assignedId: escrowId
  });

  if (!addressDoc) throw new Error("Escrow address not found");

  const { address, derivationPath, deposit } = addressDoc;

  // 2️⃣ Select available UTXO
  const utxo = deposit.find(d => !d.locked && !d.spent);

  if (!utxo) throw new Error("No spendable UTXO found");

  const valueSats = toSatoshi(utxo.value);

  if (valueSats <= feeSats)
    throw new Error("Insufficient balance after fee");

  // 3️⃣ Lock UTXO (atomic protection)
  await lockUtxo({
    address,
    txid: utxo.txid,
    vout: utxo.vout,
    lockedBy: escrowId
  });

  try {

    // 4️⃣ Derive private key
    const seed = bip39.mnemonicToSeedSync(process.env.LTC_MNEMONIC);
    const root = bip32.fromSeed(seed, NETWORK);
    const child = root.derivePath(derivationPath);

    // 5️⃣ Build transaction
    const psbt = new bitcoin.Psbt({ network: NETWORK });

    psbt.addInput({
      hash: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(utxo.scriptPubKey, "hex"),
        value: valueSats
      }
    });

    psbt.addOutput({
      address: toAddress,
      value: valueSats - feeSats
    });

    // 6️⃣ Sign
    psbt.signInput(0, child);
    psbt.finalizeAllInputs();

    const rawTx = psbt.extractTransaction().toHex();

    // 7️⃣ Broadcast
    const txid = await ltcRpc("sendrawtransaction", [rawTx]);

    // 8️⃣ Mark UTXO spent
    await markUtxoSpent({
      txid: utxo.txid,
      vout: utxo.vout
    });

    return {
      success: true,
      broadcastTxid: txid
    };

  } catch (err) {

    // ❌ If anything fails → unlock UTXO
    await db.collection(ADDRESSES_COLL).updateOne(
      {
        address,
        "deposit.txid": utxo.txid,
        "deposit.vout": utxo.vout
      },
      {
        $set: {
          "deposit.$.locked": false
        }
      }
    );

    throw err;
  }
}
