require("dotenv").config();
const express = require("express");
const path = require("path");
const { state, main: startBundler } = require("./bundler");
const { CONTRACT_ADDRESS } = require("./profitCalculator");

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

app.get("/api/status", (req, res) => {
    res.json({
        ...state,
        contractAddress: CONTRACT_ADDRESS,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
    console.log(`dashboard at http://localhost:${PORT}`);
});

startBundler().catch((err) => {
    console.error("bundler failed:", err);
});

module.exports = app;