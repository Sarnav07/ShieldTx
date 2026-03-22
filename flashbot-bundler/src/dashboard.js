/**
 * dashboard.js
 *
 * Boots the bundler AND the dashboard in one process.
 *
 *   GET /api/status  -> JSON snapshot of the bundler's live state
 *   GET /            -> Static HTML dashboard (auto-refreshes every 2s)
 *
 * Usage:
 *   MOCK_MODE=true node src/dashboard.js   -> bundler + dashboard with mock data
 *   node src/dashboard.js                  -> bundler + dashboard (live mode)
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const { state, main: startBundler } = require("./bundler");
const { CONTRACT_ADDRESS } = require("./profitCalculator");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// API -> returns the full bot state as JSON
app.get("/api/status", (req, res) => {
    res.json({
        ...state,
        contractAddress: CONTRACT_ADDRESS,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// Serve the static HTML dashboard
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

// Start dashboard server
app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
});

// Boot the bundler engine (connects to Sepolia, listens for signals)
startBundler().catch((err) => {
    console.error("Bundler failed to start:", err);
});

module.exports = app;
