require("dotenv").config();

if (process.env.NETWORK === "mainnet") {
    console.log("\n[demo] Overriding RPC endpoints to local Anvil fork (127.0.0.1:8545)...");
    process.env.RPC_WSS = "ws://127.0.0.1:8545";
    process.env.SEPOLIA_RPC_URL = "http://127.0.0.1:8545";
}

const express = require("express");
const path = require("path");

const { initBundler, state } = require("../flashbot-bundler/src/bundler");

require("./src/watchers");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

app.get("/api/status", (req, res) => {
    res.json({
        ...state,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../flashbot-bundler/public/index.html"));
});

async function start() {
    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║         ShieldTx MEV — Unified System           ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    await initBundler();

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
