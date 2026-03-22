/**
 * index.js — Unified entry point
 *
 * Boots the entire ShieldTx MEV system in a single process:
 *   1. The server's watcher (Aave position monitor + DEX arb scanner)
 *   2. The bundler engine (Flashbots bundle builder + sender)
 *   3. The Express dashboard (live status UI at http://localhost:<PORT>)
 *
 * Signal flow:
 *   watchers.js  ──emit──►  signalEmitter  ──listen──►  bundler.js
 *
 * Usage:
 *   node index.js                    → live mode
 *   MOCK_MODE=true node index.js     → with mock liquidation signal
 *   MOCK_ARB=true node index.js      → with mock arb signal
 */

require("dotenv").config();

// If we are running the live Anvil demo, force all connections to localhost
if (process.env.NETWORK === "mainnet") {
    console.log("\n[demo] Overriding RPC endpoints to local Anvil fork (127.0.0.1:8545)...");
    process.env.RPC_WSS = "ws://127.0.0.1:8545";
    process.env.SEPOLIA_RPC_URL = "http://127.0.0.1:8545";
}

const express = require("express");
const path = require("path");

// ── Boot 1: Bundler engine ────────────────────────────────────────────
const { initBundler, state } = require("../flashbot-bundler/src/bundler");

// ── Boot 2: Watcher (imports signalEmitter internally, starts listening) ──
require("./src/watchers");

// ── Boot 3: Express dashboard ─────────────────────────────────────────
const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// API → returns the full bot state as JSON
app.get("/api/status", (req, res) => {
    res.json({
        ...state,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// Serve the static HTML dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../flashbot-bundler/public/index.html"));
});

// ── Start everything ──────────────────────────────────────────────────
async function start() {
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║         ShieldTx MEV — Unified System           ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    // Initialise the bundler (connects to Sepolia + Flashbots relay,
    // registers listeners on the shared signalEmitter)
    await initBundler();

    // Start the dashboard HTTP server
    app.listen(PORT, () => {
        console.log(`\n[dashboard] Running at http://localhost:${PORT}`);
    });

    console.log("[system] Watcher + Bundler + Dashboard all running ✓\n");
}

start().catch((err) => {
    console.error("Fatal error during startup:", err);
    process.exit(1);
});

module.exports = app;
