require("dotenv").config();
const { ethers } = require("ethers");
const { AAVE_POOL_ADDRESS } = require("./constants");
const { AAVE_POOL_ABI } = require("./constants");


let provider;
let lastBlockTime = Date.now();

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    let aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);

    // Watchdog — if no block in 30s, reconnect
    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("\n[watcher] No block in 30s — reconnecting...");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);

    provider.on("block", async (blockNumber) => {
        lastBlockTime = Date.now();
        console.log(`Block ${blockNumber}`);
        const TEST_ADDRESS = "0xd7b163B671f8cE9379DF8Ff7F75fA72Ccec1841c";

        try {
            const data = await aavePool.getUserAccountData(TEST_ADDRESS);
            const hf = data.healthFactor;
            // healthFactor is 1e18 scaled — divide to get human number
            const hfReadable = (Number(hf) / 1e18).toFixed(4);
            console.log(`[liq] ${TEST_ADDRESS.slice(0, 8)}... HF: ${hfReadable}`);
        } catch (err) {
            console.log("[liq] call failed:", err.message);
        }
    });
}

createProvider();
