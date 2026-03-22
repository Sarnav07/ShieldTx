require("dotenv").config();
const { ethers } = require("ethers");

const {
    AAVE_ORACLE_ADDRESS,
    AAVE_ORACLE_ABI,
    AAVE_POOL_ADDRESS,
    AAVE_POOL_ABI,
    HF_LIQUIDATABLE,
    HF_DANGER_ZONE,
    TOKENS,
} = require("./constants");

const {
    parseAccountData,
    formatHF,
    pickBestCollateral,
    pickBestDebt,
    getMaxDebtToRepay,
} = require("./healthFactor");

const tracker = require("./positionTracker");
let provider;
let aavePool;
let aaveOracle;
let lastBlockTime = Date.now();

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

    // Watchdog
    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("\n[watcher] Reconnecting...");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);

    //ONE block listener — inside createProvider 
    provider.on("block", async (blockNumber) => {
        lastBlockTime = Date.now();
        process.stdout.write(
            `\r[watcher] Block ${blockNumber} | Positions: ${tracker.getSize()}`
        );
        await runLiquidationStrategy(blockNumber);
    });

    // Borrow / Supply discovery
    aavePool.on("Borrow", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });
    aavePool.on("Supply", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });

    provider.on("error", (err) => {
        console.error("\n[watcher] Error:", err.message);
    });

    console.log("[watcher] Connected");
}

//Liquidation strategy 
async function runLiquidationStrategy(blockNumber) {
    const tasks = [];
    for (const [address] of tracker.getAll()) {
        if (tracker.isPending(address)) continue;
        tasks.push(checkPosition(address, blockNumber));
    }
    await runInBatches(tasks, 10);
}

async function checkPosition(address, blockNumber) {
    try {
        const raw = await aavePool.getUserAccountData(address);
        const parsed = parseAccountData(raw);

        console.log(`\n[HF] ${address.slice(0, 10)}... → ${formatHF(parsed.healthFactor)}`);

        if (parsed.totalDebtUsd === 0n) {
            tracker.removePosition(address);
            return;
        }

        if (parsed.isLiquidatable) {
            console.log(`[liq] LIQUIDATABLE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
            console.log("[liq] WOULD EMIT signal");
        } else if (parsed.isDangerZone) {
            console.log(`[liq] DANGER ZONE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
        }

    } catch (err) {
        console.log(`[liq] skip ${address.slice(0, 10)}:`, err.shortMessage || err.message);
    }
}

async function runInBatches(promises, batchSize) {
    for (let i = 0; i < promises.length; i += batchSize) {
        await Promise.allSettled(promises.slice(i, i + batchSize));
    }
}

createProvider();
