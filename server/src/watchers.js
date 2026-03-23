require("dotenv").config();
const { ethers } = require("ethers");

const signalEmitter = require("./signalEmitter");

const {
    AAVE_ORACLE_ADDRESS,
    AAVE_ORACLE_ABI,
    AAVE_POOL_ADDRESS,
    AAVE_POOL_ABI,
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
} = require("../../flashbot-bundler/src/arbCalculator");

const WATCH_PAIRS = [
    { tokenIn: TOKENS.WETH.address, tokenOut: TOKENS.USDC.address, label: "WETH/USDC" },
];

let provider;
let aavePool;
let aaveOracle;
let lastBlockTime = Date.now();
let isArbScanning = false;

const stats = {
    liqChecked: 0,
    liqSignals: 0,
    arbScans: 0,
    arbSignals: 0,
};

function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("[watcher] no block in 30s, reconnecting");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);

    provider.on("block", async (blockNumber) => {
        lastBlockTime = Date.now();
        process.stdout.write(
            `\r[watcher] block ${blockNumber} | pos ${tracker.getSize()} | liq ${stats.liqSignals} | arb ${stats.arbSignals}`
        );
        await Promise.allSettled([
            runLiquidationStrategy(blockNumber),
            runArbStrategy(blockNumber),
        ]);
    });

    aavePool.on("Borrow", (_reserve, _user, onBehalfOf) => tracker.addPosition(onBehalfOf));
    aavePool.on("Supply", (_reserve, _user, onBehalfOf) => tracker.addPosition(onBehalfOf));

    provider.on("error", (err) => console.error("[watcher] provider error:", err.message));

    console.log("[watcher] connected");
    console.log("[watcher] pairs:", WATCH_PAIRS.map(p => p.label).join(", "));
}

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

        if (parsed.totalDebtUsd === 0n || parsed.healthFactor > ethers.parseUnits("1000", 18)) {
            tracker.removePosition(address);
            return;
        }

        console.log(`\n[liq] ${address.slice(0, 10)} hf ${formatHF(parsed.healthFactor)}`);

        if (parsed.isLiquidatable) {
            await handleLiquidatable(address, parsed, blockNumber);
        } else if (parsed.isDangerZone) {
            console.log(`[liq] danger zone: ${address.slice(0, 10)}`);
        }
    } catch (err) {
        console.log(`[liq] skip ${address.slice(0, 10)}: ${err.shortMessage || err.message}`);
    }
}

async function handleLiquidatable(address, parsed, blockNumber) {
    try {
        const reserves = await getUserReserves(address);
        if (!reserves || reserves.length === 0) return;

        const bestCollateral = pickBestCollateral(reserves);
        const bestDebt = pickBestDebt(reserves);

        if (!bestCollateral || !bestDebt) {
            console.log(`[liq] could not pick assets for ${address.slice(0, 10)}`);
            return;
        }

        tracker.markPending(address);
        stats.liqSignals++;

        const signal = {
            borrower: address,
            debtAsset: bestDebt.asset,
            collateralAsset: bestCollateral,
            maxDebtToRepay: getMaxDebtToRepay(bestDebt.totalDebt),
            healthFactor: parsed.healthFactor,
            blockNumber,
        };

        console.log(`[liq] signal #${stats.liqSignals} — ${signal.borrower.slice(0, 10)} debt ${signal.maxDebtToRepay}`);
        signalEmitter.emit("liquidation", signal);
    } catch (err) {
        tracker.clearPending(address);
        console.log(`[liq] error: ${err.message}`);
    }
}

async function runArbStrategy(blockNumber) {
    if (isArbScanning) return;
    isArbScanning = true;
    try {
        await Promise.allSettled(WATCH_PAIRS.map(pair => scanArbPair(pair, blockNumber)));
    } finally {
        isArbScanning = false;
    }
}

async function scanArbPair(pair, blockNumber) {
    try {
        stats.arbScans++;

        const opportunity = await findArbOpportunity(provider, pair.tokenIn, pair.tokenOut);
        if (!opportunity) return;

        const profit = await calculateArbProfit(opportunity, provider);

        console.log(
            `\n[arb] ${pair.label} block ${blockNumber}` +
            ` | ${opportunity.buyOnUniswap ? "uni→sushi" : "sushi→uni"}` +
            ` fee ${opportunity.uniswapFee / 100}%` +
            ` gross ${profit.grossProfitETH} net ${profit.netProfitETH} ETH`
        );

        if (!profit.isWorthIt) return;

        stats.arbSignals++;

        const signal = {
            ...toArbSignal(opportunity),
            profitAnalysis: profit,
            blockNumber,
            pair: pair.label,
        };

        console.log(`[arb] signal #${stats.arbSignals}`);
        signalEmitter.emit("arbitrage", signal);
    } catch (err) {
        console.error(`[arb] scan error ${pair.label}: ${err.message}`);
    }
}

async function getUserReserves(userAddress) {
    try {
        const results = await Promise.all(
            Object.values(TOKENS).map(async (token) => {
                try {
                    const data = await aavePool.getUserReserveData(token.address, userAddress);
                    const price = await aaveOracle.getAssetPrice(token.address);
                    return {
                        asset: token.address,
                        currentATokenBalance: data.currentATokenBalance,
                        currentVariableDebt: data.currentVariableDebt,
                        currentStableDebt: data.currentStableDebt,
                        usageAsCollateralEnabled: data.usageAsCollateralEnabled,
                        priceUsd: price,
                    };
                } catch {
                    return null;
                }
            })
        );
        return results.filter(Boolean);
    } catch {
        return null;
    }
}

async function runInBatches(tasks, batchSize) {
    for (let i = 0; i < tasks.length; i += batchSize) {
        await Promise.allSettled(tasks.slice(i, i + batchSize));
    }
}

createProvider();