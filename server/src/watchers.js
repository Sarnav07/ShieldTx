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

// STATE
// 
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
    backrunSignals: 0,
    protectionSignals: 0,
};

// 
// CONFIG
// 

// Arb
const WATCH_PAIRS = [
    {
        tokenIn: process.env.MAINNET_WETH,
        tokenOut: process.env.MAINNET_USDC,
        label: "WETH/USDC",
    },
];

// Backrun
const BACKRUN_MIN_SWAP_ETH = ethers.parseEther("1.0");
const KNOWN_ROUTERS = new Set([
    "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45".toLowerCase(),
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD".toLowerCase(),
]);
const backrunSeen = new Set();

// Protection
const HF_PROTECTION_THRESHOLD = ethers.parseUnits("1.1", 18);
const protectedUsers = new Set([]);
const protectionPending = new Set();

// 
// PROVIDER SETUP
// 
function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

    // confirm which network we are on
    provider.getNetwork().then(n =>
        console.log("\n[watcher] Network:", n.name, "chainId:", n.chainId)
    );

    // reconnect if no block in 30s
    const watchdog = setInterval(() => {
        if (Date.now() - lastBlockTime > 30_000) {
            console.log("\n[watcher] No block in 30s — reconnecting...");
            clearInterval(watchdog);
            createProvider();
        }
    }, 5_000);


    provider.on("block", async (blockNumber) => {
        lastBlockTime = Date.now();
        process.stdout.write(
            `\r[watcher] Block ${blockNumber} | ` +
            `Pos: ${tracker.getSize()} | ` +
            `LiqSig: ${stats.liqSignals} | ` +
            `ArbSig: ${stats.arbSignals} | ` +
            `BR: ${stats.backrunSignals} | ` +
            `Prot: ${stats.protectionSignals}`
        );
        await Promise.allSettled([
            runLiquidationStrategy(blockNumber),
            runArbStrategy(blockNumber),
            runProtectionStrategy(blockNumber),
        ]);
    });

    // auto-discover new borrowers
    aavePool.on("Borrow", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });
    aavePool.on("Supply", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });

    provider.on("error", (err) => {
        console.error("\n[watcher] Error:", err.message);
    });

    // backrun runs independently via pending
    startBackrunWatcher();

    console.log("[watcher] Connected — all 4 strategies active");
    console.log("[watcher] Watching pairs:", WATCH_PAIRS.map(p => p.label).join(", "));
    console.log("[watcher] Protected users:", protectedUsers.size);
}


// STRATEGY 1 — LIQUIDATION //

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

        console.log(`\n[HF] ${address.slice(0, 10)}... → ${formatHF(parsed.healthFactor)}`);

        if (parsed.isLiquidatable) {
            console.log(`[liq] LIQUIDATABLE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
            await handleLiquidatable(address, parsed, blockNumber);
        } else if (parsed.isDangerZone) {
            console.log(`[liq] DANGER ZONE:  ${address} HF: ${formatHF(parsed.healthFactor)}`);
        }

    } catch (err) {
        console.log(`[liq] skip ${address.slice(0, 10)}:`, err.shortMessage || err.message);
    }
}

async function handleLiquidatable(address, parsed, blockNumber) {
    try {
        const reserves = await getUserReserves(address);
        if (!reserves) return;

        const bestCollateral = pickBestCollateral(reserves);
        const bestDebt = pickBestDebt(reserves);
        if (!bestCollateral || !bestDebt) return;

        const debtAmount = getMaxDebtToRepay(bestDebt.totalDebt);

        tracker.markPending(address);
        stats.liqSignals++;

        const signal = {
            user: address,
            debtAsset: bestDebt.asset,
            collateralAsset: bestCollateral,
            debtAmount: debtAmount.toString(),
            healthFactor: formatHF(parsed.healthFactor),
            blockNumber,
        };

        console.log(`[liq] SIGNAL #${stats.liqSignals} — WOULD EMIT LIQUIDATABLE`);
        console.log(`      user:       ${signal.user.slice(0, 10)}...`);
        console.log(`      debtAsset:  ${signal.debtAsset}`);
        console.log(`      collateral: ${signal.collateralAsset}`);
        console.log(`      debtAmount: ${signal.debtAmount}`);
        console.log(`      HF:         ${signal.healthFactor}`);

    } catch (err) {
        tracker.clearPending(address);
        console.log(`[liq] handleLiquidatable error:`, err.message);
    }
}


// STRATEGY 2 — ARBITRAGE //

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

        console.log(`[arb] SIGNAL #${stats.arbSignals} — WOULD EMIT ARB_SIGNAL`);
        console.log(`      Tip to builder: ${profitAnalysis.recommendedTipETH} ETH`);
        console.log(`      You keep:       ${profitAnalysis.keeperProfitETH} ETH`);

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
            if (!KNOWN_ROUTERS.has(tx.to.toLowerCase())) return;
            if (tx.value < BACKRUN_MIN_SWAP_ETH) return;

            backrunSeen.add(txHash);
            if (backrunSeen.size > 500) {
                backrunSeen.delete(backrunSeen.values().next().value);
            }

            const valueEth = parseFloat(ethers.formatEther(tx.value)).toFixed(4);
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

            console.log(`\n[backrun] SIGNAL #${stats.backrunSignals} — WOULD EMIT BACKRUN_TARGET`);
            console.log(`          TxHash: ${txHash}`);
            console.log(`          Value:  ${valueEth} ETH`);
            console.log(`          From:   ${tx.from}`);
            console.log(`          To:     ${tx.to}`);
            console.log(`          Gas:    ${tx.maxFeePerGas
                ? ethers.formatUnits(tx.maxFeePerGas, "gwei") + " gwei"
                : "legacy"}`);

        } catch (_) { }
    });
}


// STRATEGY 4 — PROTECTION //

async function runProtectionStrategy(blockNumber) {
    if (protectedUsers.size === 0) return;

    const tasks = [];
    for (const address of protectedUsers) {
        if (protectionPending.has(address)) continue;
        tasks.push(checkProtectionNeeded(address, blockNumber));
    }
    await runInBatches(tasks, 10);
}

async function checkProtectionNeeded(address, blockNumber) {
    try {
        const raw = await aavePool.getUserAccountData(address);
        const parsed = parseAccountData(raw);

        if (parsed.totalDebtUsd === 0n || parsed.healthFactor > ethers.parseUnits("1000", 18)) {
            return;
        }

        if (parsed.healthFactor > HF_PROTECTION_THRESHOLD) return;

        console.log(
            `\n[protection] User needs help: ${address.slice(0, 10)}...` +
            ` HF: ${formatHF(parsed.healthFactor)}`
        );

        const reserves = await getUserReserves(address);
        if (!reserves) return;

        const bestDebt = pickBestDebt(reserves);
        if (!bestDebt) return;

        const repayAmount = (bestDebt.totalDebt * 25n) / 100n;

        protectionPending.add(address);
        stats.protectionSignals++;

        const signal = {
            user: address,
            debtAsset: bestDebt.asset,
            repayAmount: repayAmount.toString(),
            healthFactor: formatHF(parsed.healthFactor),
            blockNumber,
        };

        console.log(`[protection] SIGNAL #${stats.protectionSignals} — WOULD EMIT PROTECTION_NEEDED`);
        console.log(`             user:        ${signal.user.slice(0, 10)}...`);
        console.log(`             debtAsset:   ${signal.debtAsset}`);
        console.log(`             repayAmount: ${signal.repayAmount}`);
        console.log(`             HF:          ${signal.healthFactor}`);

    } catch (err) {
        console.log(
            `[protection] skip ${address.slice(0, 10)}:`,
            err.shortMessage || err.message
        );
    }
}

function clearProtectionPending(address) {
    protectionPending.delete(address.toLowerCase());
}


// SHARED UTILS //

async function getUserReserves(userAddress) {
    const tokenList = Object.values(TOKENS);
    try {
        const results = await Promise.all(
            tokenList.map(async (token) => {
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
                } catch { return null; }
            })
        );
        return results.filter(Boolean);
    } catch (_) {
        return null;
    }
}

async function runInBatches(promises, batchSize) {
    for (let i = 0; i < promises.length; i += batchSize) {
        await Promise.allSettled(promises.slice(i, i + batchSize));
    }
}


createProvider();