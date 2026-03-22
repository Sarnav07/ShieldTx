//replaced console with emit and actionable payload

require("dotenv").config();
const { ethers } = require("ethers");


const signalEmitter = require("./signalEmitter");

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


// STATE //

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


// CONFIG //


const WATCH_PAIRS = [
    {
        tokenIn: TOKENS.WETH.address,
        tokenOut: TOKENS.USDC.address,
        label: "WETH/USDC",
    },
];

const BACKRUN_MIN_SWAP_ETH = ethers.parseEther("0.1"); // lower threshold for Sepolia
const KNOWN_ROUTERS = new Set([
    // Uniswap V3 SwapRouter02 on Sepolia
    "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E".toLowerCase(),
    // Uniswap Universal Router on Sepolia
    "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD".toLowerCase(),
]);
const backrunSeen = new Set();

const HF_PROTECTION_THRESHOLD = ethers.parseUnits("1.1", 18);
const protectedUsers = new Set([]);
const protectionPending = new Set();

// ── Uniswap V3 swap function selector for calldata decoding ───────
// exactInputSingle selector = 0x414bf389
// exactInput selector       = 0xc04b8d59
const SWAP_SELECTORS = new Set([
    "0x414bf389", // exactInputSingle
    "0xc04b8d59", // exactInput
    "0xdb3e2198", // exactOutputSingle
    "0xf28c0498", // exactOutput
]);

// 
// PROVIDER SETUP
// 
function createProvider() {
    provider = new ethers.WebSocketProvider(process.env.RPC_WSS);
    aavePool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI, provider);
    aaveOracle = new ethers.Contract(AAVE_ORACLE_ADDRESS, AAVE_ORACLE_ABI, provider);

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

    aavePool.on("Borrow", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });
    aavePool.on("Supply", (reserve, user, onBehalfOf) => {
        tracker.addPosition(onBehalfOf);
    });

    provider.on("error", (err) => {
        console.error("\n[watcher] Error:", err.message);
    });

    startBackrunWatcher();

    console.log("[watcher] Connected — all 4 strategies active");
    console.log("[watcher] Watching pairs:", WATCH_PAIRS.map(p => p.label).join(", "));
}

// 
// STRATEGY 1 — LIQUIDATION
// 
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
            console.log(`[liq] DANGER ZONE: ${address} HF: ${formatHF(parsed.healthFactor)}`);
        }

    } catch (err) {
        console.log(`[liq] skip ${address.slice(0, 10)}:`, err.shortMessage || err.message);
    }
}


async function handleLiquidatable(address, parsed, blockNumber) {
    try {
        // fetch per-token reserves to find best debt and collateral
        const reserves = await getUserReserves(address);
        if (!reserves || reserves.length === 0) return;

        const bestCollateral = pickBestCollateral(reserves);
        const bestDebt = pickBestDebt(reserves);

        if (!bestCollateral || !bestDebt) {
            console.log(`[liq] could not determine best assets for ${address.slice(0, 10)}`);
            return;
        }

        // apply 50% close factor — Aave only allows repaying half
        const debtAmount = getMaxDebtToRepay(bestDebt.totalDebt);

        tracker.markPending(address);
        stats.liqSignals++;

        // full actionable payload C needs to build the bundle
        const signal = {
            borrower: address,
            debtAsset: bestDebt.asset,
            collateralAsset: bestCollateral,
            maxDebtToRepay: debtAmount,        // BigInt — C uses this directly
            healthFactor: parsed.healthFactor,
            blockNumber,
        };

        console.log(`[liq] Signal #${stats.liqSignals} emitted`);
        console.log(`      borrower:   ${signal.borrower.slice(0, 10)}...`);
        console.log(`      debtAsset:  ${signal.debtAsset}`);
        console.log(`      collateral: ${signal.collateralAsset}`);
        console.log(`      debtAmount: ${signal.maxDebtToRepay.toString()}`);


        signalEmitter.emit("liquidation", signal);

    } catch (err) {
        tracker.clearPending(address);
        console.log(`[liq] handleLiquidatable error:`, err.message);
    }
}

//
// STRATEGY 2 — ARBITRAGE
// 
async function runArbStrategy(blockNumber) {
    if (isArbScanning) return;
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
            `\n      Buy DEX:  ${opportunity.buyOnUniswap ? "Uniswap V3" : "Sushiswap V2"}` +
            `\n      Sell DEX: ${opportunity.buyOnUniswap ? "Sushiswap V2" : "Uniswap V3"}` +
            `\n      Uni fee:  ${opportunity.uniswapFee / 100}%` +
            `\n      Gross:    ${profitAnalysis.grossProfitETH} ETH` +
            `\n      Gas cost: ${profitAnalysis.gasCostETH} ETH` +
            `\n      Net:      ${profitAnalysis.netProfitETH} ETH` +
            `\n      Worth it: ${profitAnalysis.isWorthIt}`
        );

        if (!profitAnalysis.isWorthIt) {
            console.log(`[arb] Below threshold — skipping`);
            return;
        }

        stats.arbSignals++;

        const signal = {
            ...toArbSignal(opportunity),
            profitAnalysis,
            blockNumber,
            pair: pair.label,
        };

        console.log(`[arb] Signal #${stats.arbSignals} emitted`);

        // ── Issue 1 fix: real emit ────────────────────────────────
        signalEmitter.emit("arbitrage", signal);

    } catch (err) {
        console.error(`\n[arb] Error scanning ${pair.label}:`, err.message);
    }
}

// 
// STRATEGY 3 — BACKRUN
// 
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

            const decoded = decodeSwapCalldata(tx.data);

            stats.backrunSignals++;

            const signal = {
                txHash,
                to: tx.to,
                value: tx.value.toString(),
                valueEth: parseFloat(valueEth),
                gasPrice: tx.maxFeePerGas?.toString() || tx.gasPrice?.toString(),
                from: tx.from,
                data: tx.data,
                // decoded swap details
                tokenIn: decoded?.tokenIn || null,
                tokenOut: decoded?.tokenOut || null,
                amountIn: decoded?.amountIn || null,
                buyOnUniswap: false,   // sell on Uni to counter the target's buy
                uniswapFee: 3000,
            };

            console.log(`\n[backrun] Signal #${stats.backrunSignals} emitted`);
            console.log(`          TxHash:   ${txHash.slice(0, 12)}...`);
            console.log(`          Value:    ${valueEth} ETH`);
            console.log(`          TokenIn:  ${signal.tokenIn || "could not decode"}`);
            console.log(`          TokenOut: ${signal.tokenOut || "could not decode"}`);
            console.log(`          AmountIn: ${signal.amountIn || "could not decode"}`);

            //emit
            signalEmitter.emit("backrun", signal);

        } catch (_) { }
    });
}

function decodeSwapCalldata(data) {
    if (!data || data.length < 10) return null;

    const selector = data.slice(0, 10).toLowerCase();

    try {
        // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
        if (selector === "0x414bf389") {
            const abiCoder = ethers.AbiCoder.defaultAbiCoder();
            const decoded = abiCoder.decode(
                ["tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)"],
                "0x" + data.slice(10)
            );
            return {
                tokenIn: decoded[0].tokenIn,
                tokenOut: decoded[0].tokenOut,
                amountIn: decoded[0].amountIn.toString(),
            };
        }

        // exactInput((bytes,address,uint256,uint256,uint256))
        if (selector === "0xc04b8d59") {
            const abiCoder = ethers.AbiCoder.defaultAbiCoder();
            const decoded = abiCoder.decode(
                ["tuple(bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)"],
                "0x" + data.slice(10)
            );
            // path is encoded as bytes — first 20 bytes = tokenIn, last 20 bytes = tokenOut
            const path = decoded[0].path;
            const tokenIn = "0x" + path.slice(2, 42);
            const tokenOut = "0x" + path.slice(path.length - 40);
            return {
                tokenIn,
                tokenOut,
                amountIn: decoded[0].amountIn.toString(),
            };
        }

    } catch (_) {
        return null;
    }

    return null;
}

// 
// STRATEGY 4 — PROTECTION
// 
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
            repayAmount,
            healthFactor: parsed.healthFactor,
            blockNumber,
        };

        console.log(`[protection] Signal #${stats.protectionSignals} emitted`);

        //
        signalEmitter.emit("protection", signal);

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

// 
// SHARED UTILS
// 
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