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

const {
    findArbOpportunity,
    calculateArbProfit,
    toArbSignal,
    ARB_CONFIG,
} = require("./arbCalculator");
let provider;
let aavePool;
let aaveOracle;
let lastBlockTime = Date.now();

// Part 4: arb state
let isArbScanning = false;
let stats = {
    liqChecked: 0,
    liqSignals: 0,
    arbScans: 0,
    arbSignals: 0,
};

// Using Sepolia addresses from arbCalculator.js
const WATCH_PAIRS = [
    {
        tokenIn: process.env.SEPOLIA_WETH,
        tokenOut: process.env.SEPOLIA_USDC,
        label: "WETH/USDC",
    },
];

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

    // Watchdog — reconnect if no block in 30s
    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("\n[watcher] No block in 30s — reconnecting...");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);

    // ── Part 4: block listener now runs BOTH strategies ──────────
    provider.on("block", async (blockNumber) => {
        lastBlockTime = Date.now();

        process.stdout.write(
            `\r[watcher] Block ${blockNumber} | ` +
            `Pos: ${tracker.getSize()} | ` +
            `LiqSig: ${stats.liqSignals} | ` +
            `ArbSig: ${stats.arbSignals}`
        );

        // Run liquidation and arb in parallel — neither waits for the other
        await Promise.allSettled([
            runLiquidationStrategy(blockNumber),
            runArbStrategy(blockNumber),
        ]);
    });

    // Auto-discover new borrowers
    aavePool.on("Borrow", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });
    aavePool.on("Supply", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });

    provider.on("error", (err) => {
        console.error("\n[watcher] Error:", err.message);
    });

    console.log("[watcher] Connected — running liquidation + arb");
    console.log("[watcher] Watching pairs:", WATCH_PAIRS.map(p => p.label).join(", "));
}

//liquidation
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
        stats.liqChecked++;

        console.log(`\n[HF] ${address.slice(0, 10)}... → ${formatHF(parsed.healthFactor)}`);

        if (parsed.totalDebtUsd === 0n) {
            tracker.removePosition(address);
            return;
        }

        if (parsed.isLiquidatable) {
            console.log(`[liq] LIQUIDATABLE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
            console.log("[liq] WOULD EMIT signal");   // replaced in Part 5
        } else if (parsed.isDangerZone) {
            console.log(`[liq] DANGER ZONE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
        }

    } catch (err) {
        console.log(`[liq] skip ${address.slice(0, 10)}:`, err.shortMessage || err.message);
    }
}

async function runArbStrategy(blockNumber) {
    if (isArbScanning) {
        console.log(`\n[arb] Block ${blockNumber} — scan still running, skipping`);
        return;
    }

    isArbScanning = true;

    try {
        await Promise.allSettled(
            WATCH_PAIRS.map(pair => scanArbPair(pair, blockNumber))
        );
    } finally {
        isArbScanning = false;
    }
}

async function scanArbPair(pair, blockNumber) {
    try {
        stats.arbScans++;

        // Step 1: find price gap across all fee tier combinations
        const opportunity = await findArbOpportunity(
            provider,
            pair.tokenIn,
            pair.tokenOut
        );

        if (!opportunity) {
            console.log(`\n[arb] ${pair.label} Block ${blockNumber} — no opportunity`);
            return;
        }

        // Step 2: subtract gas cost, compute tip
        const profitAnalysis = await calculateArbProfit(opportunity, provider);

        // Step 3: always log what was found
        console.log(
            `\n[arb] ${pair.label} | Block ${blockNumber}` +
            `\n      Buy fee:  ${opportunity.buyFee / 10000}%` +
            `\n      Sell fee: ${opportunity.sellFee / 10000}%` +
            `\n      Gross:    ${profitAnalysis.grossProfitETH} ETH` +
            `\n      Gas cost: ${profitAnalysis.gasCostETH} ETH` +
            `\n      Net:      ${profitAnalysis.netProfitETH} ETH` +
            `\n      Worth it: ${profitAnalysis.isWorthIt}`
        );

        // Step 4: if not profitable after gas — stop here
        if (!profitAnalysis.isWorthIt) {
            console.log(`[arb] Below threshold (${ARB_CONFIG.MIN_PROFIT_ETH} ETH) — skipping`);
            return;
        }

        // Step 5: profitable — build signal and log it
        stats.arbSignals++;

        const signal = {
            ...toArbSignal(opportunity),
            profitAnalysis,
            blockNumber,
            pair: pair.label,
        };

        console.log(
            `\n[arb] ARB SIGNAL #${stats.arbSignals}` +
            `\n      Tip to builder: ${profitAnalysis.recommendedTipETH} ETH` +
            `\n      You keep:       ${profitAnalysis.keeperProfitETH} ETH`
        );

        // replaced with emitter.emit() in Part 5
        console.log("[arb] WOULD EMIT ARB_SIGNAL", JSON.stringify(signal, null, 2));

    } catch (err) {
        console.error(`\n[arb] Error scanning ${pair.label}:`, err.message);
    }
}

async function runInBatches(promises, batchSize) {
    for (let i = 0; i < promises.length; i += batchSize) {
        await Promise.allSettled(promises.slice(i, i + batchSize));
    }
}

createProvider();
