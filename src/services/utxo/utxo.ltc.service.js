import { getDB } from "../../config/db.js";
import { NETWORK } from "../wallet/ltc.service.js";

const ADDRESSES_COLL = "addresses_ltc";

export async function lockUtxo({ address, txid, vout, lockedBy }) {
  const db = getDB();

  const res = await db.collection(ADDRESSES_COLL).updateOne(
    {
      address,
      deposit: {
        $elemMatch: {
          txid,
          vout,
          locked: false,
          spent: false
        }
      }
    },
    {
      $set: {
        "deposit.$.locked": true,
        "deposit.$.lockedAt": new Date(),
        "deposit.$.lockedBy": lockedBy
      }
    }
  );

  if (res.modifiedCount === 0) {
    throw new Error("UTXO already locked or spent");
  }
}
export async function markUtxoSpent({ txid, vout }) {
  const db = getDB();

  await db.collection(ADDRESSES_COLL).updateOne(
    {
      "deposit.txid": txid,
      "deposit.vout": vout
    },
    {
      $set: {
        "deposit.$.spent": true,
        "deposit.$.spentAt": new Date(),
        "deposit.$.locked": false
      }
    }
  );
}
