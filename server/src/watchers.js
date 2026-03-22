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
} = require("../../flashbot-bundler/src/arbCalculator");

// State 
let provider;
let aavePool;
let aaveOracle;
let lastBlockTime = Date.now();
let isArbScanning = false;

let stats = {
    liqChecked: 0,
    liqSignals: 0,
    arbScans: 0,
    arbSignals: 0,
    backrunSignals: 0, // ← new
};

//Arb config 
const WATCH_PAIRS = [
    {
        tokenIn: process.env.MAINNET_WETH,
        tokenOut: process.env.MAINNET_USDC,
        label: "WETH/USDC",
    },
];

//Backrun config 
const BACKRUN_MIN_SWAP_ETH = ethers.parseEther("1.0"); // 1 ETH min on mainnet
const KNOWN_ROUTERS = new Set([
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45".toLowerCase(), // SwapRouter02 mainnet
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD".toLowerCase(), // UniversalRouter mainnet
]);
const backrunSeen = new Set();


// PROVIDER SETUP

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

    //will reconnect if no block in 30s
    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("\n[watcher] No block in 30s — reconnecting...");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);

    // Block listener — liquidation + arb in parallel
    provider.on("block", async (blockNumber) => {
        lastBlockTime = Date.now();
        process.stdout.write(
            `\r[watcher] Block ${blockNumber} | ` +
            `Pos: ${tracker.getSize()} | ` +
            `LiqSig: ${stats.liqSignals} | ` +
            `ArbSig: ${stats.arbSignals} | ` +
            `BR: ${stats.backrunSignals}`
        );
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

    // Backrun starts independently 
    startBackrunWatcher();

    console.log("[watcher] Connected — liquidation + arb + backrun active");
    console.log("[watcher] Watching pairs:", WATCH_PAIRS.map(p => p.label).join(", "));
}

// STRATEGY 1 — LIQUIDATION

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

        // type(uint256).max = no debt — remove and skip
        if (parsed.totalDebtUsd === 0n || parsed.healthFactor > ethers.parseUnits("1000", 18)) {
            tracker.removePosition(address);
            return;
        }

        console.log(`\n[HF] ${address.slice(0, 10)}... → ${formatHF(parsed.healthFactor)}`);

        if (parsed.isLiquidatable) {
            console.log(`[liq] LIQUIDATABLE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
            console.log("[liq] WOULD EMIT signal"); // replaced in Part 5
        } else if (parsed.isDangerZone) {
            console.log(`[liq] DANGER ZONE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
        }

    } catch (err) {
        console.log(`[liq] skip ${address.slice(0, 10)}:`, err.shortMessage || err.message);
    }
}

// STRATEGY 2 — ARBITRAGE

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

        const opportunity = await findArbOpportunity(
            provider,
            pair.tokenIn,
            pair.tokenOut
        );

        if (!opportunity) {
            console.log(`\n[arb] ${pair.label} Block ${blockNumber} — no opportunity`);
            return;
        }

        const profitAnalysis = await calculateArbProfit(opportunity, provider);

        console.log(
            `\n[arb] ${pair.label} | Block ${blockNumber}` +
            `\n      Buy fee:  ${opportunity.buyFee / 10000}%` +
            `\n      Sell fee: ${opportunity.sellFee / 10000}%` +
            `\n      Gross:    ${profitAnalysis.grossProfitETH} ETH` +
            `\n      Gas cost: ${profitAnalysis.gasCostETH} ETH` +
            `\n      Net:      ${profitAnalysis.netProfitETH} ETH` +
            `\n      Worth it: ${profitAnalysis.isWorthIt}`
        );

        if (!profitAnalysis.isWorthIt) {
            console.log(`[arb] Below threshold (${ARB_CONFIG.MIN_PROFIT_ETH} ETH) — skipping`);
            return;
        }

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
        console.log("[arb] WOULD EMIT ARB_SIGNAL", JSON.stringify(signal, null, 2));

    } catch (err) {
        console.error(`\n[arb] Error scanning ${pair.label}:`, err.message);
    }
}


// STRATEGY 3 — BACKRUN //

function startBackrunWatcher() {
    console.log("[backrun] Watching mempool...");

    let pendingCount = 0;

    provider.on("pending", async (txHash) => {
        pendingCount++;

        if (pendingCount % 50 === 0) {
            process.stdout.write(`\r[backrun] Pending txs seen: ${pendingCount}`);
        }

        if (backrunSeen.has(txHash)) return;

        try {
            const tx = await provider.getTransaction(txHash);
            if (!tx || !tx.to) return;

            // we only care about known DEX routers
            if (!KNOWN_ROUTERS.has(tx.to.toLowerCase())) return;

            // we only care about swaps above size threshold
            if (tx.value < BACKRUN_MIN_SWAP_ETH) return;

            // mark as seen — prevent duplicate processing
            backrunSeen.add(txHash);
            if (backrunSeen.size > 500) {
                backrunSeen.delete(backrunSeen.values().next().value);
            }

            const valueEth = parseFloat(ethers.formatEther(tx.value)).toFixed(4);

            console.log(
                `\n[backrun] Large swap detected!` +
                `\n          TxHash: ${txHash}` +
                `\n          To:     ${tx.to}` +
                `\n          Value:  ${valueEth} ETH` +
                `\n          From:   ${tx.from}` +
                `\n          Gas:    ${tx.maxFeePerGas
                    ? ethers.formatUnits(tx.maxFeePerGas, "gwei") + " gwei"
                    : "legacy"}`
            );

            stats.backrunSignals++;

            const signal = {
                txHash,
                to: tx.to,
                value: tx.value.toString(),
                valueEth: parseFloat(valueEth),
                gasPrice: tx.maxFeePerGas?.toString() || tx.gasPrice?.toString(),
                from: tx.from,
                data: tx.data,
            };

            console.log("[backrun] WOULD EMIT BACKRUN_TARGET"); //will be replaced later

            console.log("[backrun] Signal:", JSON.stringify(signal, null, 2));

        } catch (_) {
            // tx may have been dropped from mempool — silent fail
        }
    });
}

async function runInBatches(promises, batchSize) {
    for (let i = 0; i < promises.length; i += batchSize) {
        await Promise.allSettled(promises.slice(i, i + batchSize));
    }
}

createProvider();