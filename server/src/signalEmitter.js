/**
 * signalEmitter.js
 *
 * Shared EventEmitter singleton — the bridge between Person B's watcher
 * and Person C's bundler.
 *
 * Events:
 *   "liquidation" → { borrower, debtAsset, collateralAsset, maxDebtToRepay, collateralAmount, healthFactor }
 *   "arbitrage"   → { type, tokenIn, tokenOut, amountIn, dexA, dexB, buyFee, sellFee, expectedProfitRaw }
 *
 * Both watchers.js and bundler.js import this same instance so signals
 * flow in-process without any network hop.
 */

const { EventEmitter } = require("events");

const signalEmitter = new EventEmitter();

module.exports = signalEmitter;
