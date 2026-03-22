require("dotenv").config();
const { ethers } = require("ethers");

let provider;
let lastBlockTime = Date.now();

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);

    //if no block in 30s, reconnect
    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("\n[watcher] No block in 30s — reconnecting...");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);

    provider.on("block", (blockNumber) => {
        lastBlockTime = Date.now();
        console.log(`Block ${blockNumber}`);
    });

    provider.on("error", (err) => {
        console.error("[watcher] Error:", err.message);
    });

    console.log("[watcher] Connected");
}

createProvider();