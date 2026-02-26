import * as ecc from "tiny-secp256k1";
import bip39 from "bip39";
import { BIP32Factory } from "bip32";
import * as bitcoin from "bitcoinjs-lib";
import { getDB } from "../../config/db.js";

const bip32 = BIP32Factory(ecc);

const WALLETS_COLL = "wallet_ltc";
const ADDRESSES_COLL = "addresses_ltc";

/* ---------------- LITECOIN NETWORK ---------------- */

const LITECOIN_NETWORK = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: {
    public: 0x019da462,   // Ltub
    private: 0x019d9cfe   // Ltpv
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

export const NETWORK = LITECOIN_NETWORK;

/* BIP84: Native SegWit */
const ACCOUNT_PATH = "m/84'/2'/0'";

/* ---------------- INIT MASTER WALLET ---------------- */

export async function initMasterWallet() {
  const db = getDB();

  const exists = await db.collection(WALLETS_COLL).findOne({});
  if (exists) return exists;

  const mnemonic = process.env.LTC_MNEMONIC;
  if (!mnemonic) throw new Error("LTC_MNEMONIC not set");

  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error("Invalid LTC mnemonic");
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);
  const account = root.derivePath(ACCOUNT_PATH);
  const xpub = account.neutered().toBase58();

  const wallet = {
    xpub,
    nextIndex: 0,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  await db.collection(WALLETS_COLL).insertOne(wallet);
  console.log("✅ Litecoin master wallet initialized");

  return wallet;
}

/* ---------------- DERIVE ADDRESS ---------------- */

function deriveAddressFromXpub(xpub, index) {
  const node = bip32.fromBase58(xpub, NETWORK);
  const child = node.derive(0).derive(index);

  const { address } = bitcoin.payments.p2wpkh({
    pubkey: child.publicKey,
    network: NETWORK
  });

  return address; // ltc1...
}

/* ---------------- ALLOCATE DEPOSIT ADDRESS ---------------- */

export async function allocateDepositAddress({ id }) {
  const db = getDB();
  const wallet = await db.collection(WALLETS_COLL).findOne({});
  if (!wallet) throw new Error("Litecoin wallet not initialized");

  const res = await db.collection(WALLETS_COLL).findOneAndUpdate(
    {},
    { $inc: { nextIndex: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );

  const index = res.nextIndex - 1;
  const address = deriveAddressFromXpub(wallet.xpub, index);

  await db.collection(ADDRESSES_COLL).insertOne({
  index,
  address,
  assignedId: id,

  network: "ltc",
  derivationPath: `m/84'/2'/0'/0/${index}`,

  used: false,
  watching: true,
  watchUntil: new Date(Date.now() + 30 * 60 * 1000),
  lastCheckedHeight: null,

  confirmed: false,

  deposit: [],   // ARRAY of UTXOs
  withdraw: [],

  createdAt: new Date(),
  updatedAt: new Date()
});

  return { index, address };
}



/* ---------------- VALIDATE ADDRESS ---------------- */

export function validateAddress(address) {
  try {
    bitcoin.address.toOutputScript(address, NETWORK);
    return true;
  } catch {
    return false;
  }
}
