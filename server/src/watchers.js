//Part 1
require("dotenv").config();
const { ethers } = require("ethers");

const {
    AAVE_ORACLE_ADDRESS,
    AAVE_ORACLE_ABI,
    AAVE_POOL_ADDRESS,
    AAVE_POOL_ABI,
    HF_LIQUIDATABLE,
    HF_DANGER_ZONE,
} = require("./constants");

const {
    parseAccountData,
    formatHF,
    pickBestCollateral,
    pickBestDebt,
    getMaxDebtToRepay,
} = require("./healthFactor");

const tracker = require("./positionTracker");
const { TOKENS } = require("./constants");


let provider;
let lastBlockTime = Date.now();

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    let aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    let aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);


    // Watchdog — if no block in 30s, reconnect
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

    aavePool.on("Borrow", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });
    aavePool.on("Supply", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });
}

createProvider();

provider.on("block", async (blockNumber) => {
    lastBlockTime = Date.now();
    process.stdout.write(
        `\r[watcher] Block ${blockNumber} | Positions: ${tracker.getSize()}`
    );
    await runLiquidationStrategy(blockNumber);
});

// Part 3 additions

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

        if (parsed.totalDebtUsd === 0n) {
            tracker.removePosition(address);
            return;
        }

        if (parsed.isLiquidatable) {
            console.log(`\n[liq] LIQUIDATABLE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
            console.log("[liq] WOULD EMIT LIQUIDATABLE signal");
        } else if (parsed.isDangerZone) {
            console.log(`\n[liq] DANGER: ${address} HF: ${formatHF(parsed.healthFactor)}`);
        }
    } catch (_) { }
}

async function runInBatches(promises, batchSize) {
    for (let i = 0; i < promises.length; i += batchSize) {
        await Promise.allSettled(promises.slice(i, i + batchSize));
    }
}