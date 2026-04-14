import express from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { listUserTransactions } from "../models/Transaction.js";
import { findByUserId } from "../models/User.js";

const router = express.Router();

const TYPE_FILTERS = new Set(["sent", "received"]);
const STATUS_FILTERS = new Set(["completed", "pending", "failed"]);

function parsePagination(query) {
	const parsedLimit = Number.parseInt(query?.limit, 10);
	const parsedOffset = Number.parseInt(query?.offset, 10);

	const limit = Number.isInteger(parsedLimit)
		? Math.min(Math.max(parsedLimit, 1), 100)
		: 50;
	const offset = Number.isInteger(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

	return { limit, offset };
}

function normalizeStatus(status) {
	const value = String(status || "pending").toLowerCase();

	if (["completed", "released", "success", "done", "paid"].includes(value)) {
		return "completed";
	}

	if (["failed", "error", "rejected", "cancelled", "refunded"].includes(value)) {
		return "failed";
	}

	return "pending";
}

function getTypeForUser(tx, userId) {
	return tx?.buyerId === userId ? "sent" : "received";
}

function getDirection(type) {
	return type === "sent" ? "out" : "in";
}

function getCounterpartyId(tx, userId) {
	return tx?.buyerId === userId ? tx?.sellerId : tx?.buyerId;
}

function buildTransactionId(tx) {
	if (tx?.transactionId !== undefined && tx?.transactionId !== null) {
		return `tx_${tx.transactionId}`;
	}
	return tx?._id ? String(tx._id) : null;
}

function getTxHash(tx) {
	return tx?.txHash || tx?.txId || tx?.releaseTxHash || tx?.cancelTxHash || null;
}

function mapTransaction(tx, userId, counterpartyUsername) {
	const type = getTypeForUser(tx, userId);
	const status = normalizeStatus(tx?.status);

	return {
		id: buildTransactionId(tx),
		escrowId: tx?.escrowId || tx?.escrow_id || null,
		type,
		direction: getDirection(type),
		amount: tx?.amount ?? tx?.amountBTC ?? tx?.amountBtc ?? 0,
		coin: String(tx?.currency || tx?.coin || "BTC").toUpperCase(),
		status,
		counterparty: counterpartyUsername || null,
		counterparty_address:
			type === "sent"
				? tx?.sellerWalletAddress || tx?.counterparty_address || null
				: tx?.buyerWalletAddress || tx?.counterparty_address || null,
		txHash: getTxHash(tx),
		confirmations: Number(tx?.confirmations || 0),
		createdAt: tx?.createdAt || null,
		completedAt:
			status === "completed"
				? tx?.completedAt || tx?.completed_at || tx?.updatedAt || null
				: null,
	};
}

// All transaction routes require authentication
router.use(authenticate);

/* ------------------ GET USER TRANSACTIONS ------------------ */
router.get("/transactions", async (req, res) => {
	try {
		const userId = req.user.userId;
		const typeFilter = req.query.type ? String(req.query.type).toLowerCase() : null;
		const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;
		const { limit, offset } = parsePagination(req.query);

		if (typeFilter && !TYPE_FILTERS.has(typeFilter)) {
			return res.status(400).json({
				error: "Invalid transaction type",
				code: "INVALID_TYPE",
				details: "type must be one of: sent, received",
			});
		}

		if (statusFilter && !STATUS_FILTERS.has(statusFilter)) {
			return res.status(400).json({
				error: "Invalid transaction status",
				code: "INVALID_STATUS",
				details: "status must be one of: completed, pending, failed",
			});
		}

		const transactions = await listUserTransactions(userId);
		const userCache = new Map();

		const resolveUsername = async (targetUserId) => {
			if (!targetUserId && targetUserId !== 0) {
				return null;
			}
			if (userCache.has(targetUserId)) {
				return userCache.get(targetUserId);
			}

			const user = await findByUserId(targetUserId);
			const username = user?.username || null;
			userCache.set(targetUserId, username);
			return username;
		};

		const filtered = [];
		for (const tx of transactions || []) {
			const txType = getTypeForUser(tx, userId);
			const txStatus = normalizeStatus(tx?.status);

			if (typeFilter && txType !== typeFilter) {
				continue;
			}
			if (statusFilter && txStatus !== statusFilter) {
				continue;
			}

			const counterpartyId = getCounterpartyId(tx, userId);
			const counterpartyUsername = await resolveUsername(counterpartyId);
			filtered.push(mapTransaction(tx, userId, counterpartyUsername));
		}

		return res.status(200).json(filtered.slice(offset, offset + limit));
	} catch (error) {
		console.error("Get Transactions Error:", error);
		return res.status(500).json({
			error: "Server error",
			code: "INTERNAL_SERVER_ERROR",
		});
	}
});

export default router;
