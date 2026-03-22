/**
 * bundler.js
 *
 * Core engine for Person C — the Flashbots integration layer.
 * Supports multiple MEV strategies:
 *   - Aave V3 Liquidations (mode 1)
 *   - DEX Arbitrage across Uniswap V3 fee tiers (mode 2)
 *
 * 5 Jobs:
 *   1. Listen for liquidation + arbitrage signals
 *   2. Encode the appropriate contract call using Person A's ABI
 *   3. Simulate via Flashbots eth_callBundle before sending
 *   4. Calculate builder tip and build the bundle for block N and N+1
 *   5. Sign and send via FlashbotsBundleProvider
 *
 * Usage:
 *   node src/bundler.js                          — runs with live watcher
 *   MOCK_MODE=true node src/bundler.js           — runs with a mock signal for testing
 *   MOCK_ARB=true node src/bundler.js            — runs with a mock arbitrage signal
 */

require("dotenv").config();
const { ethers } = require("ethers");
const {
    FlashbotsBundleProvider,
    FlashbotsBundleResolution,
} = require("@flashbots/ethers-provider-bundle");
const signalEmitter = require("../../server/src/signalEmitter");
const path = require("path");
const fs = require("fs");

const { calculateProfit, CONTRACT_ADDRESS, CONFIG, SEPOLIA_WETH, SEPOLIA_USDC } = require("./profitCalculator");
const { calculateArbProfit, SEPOLIA_ADDRESSES } = require("./arbCalculator");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SEPOLIA_CHAIN_ID = 11155111;
const FLASHBOTS_RELAY_SEPOLIA = "https://relay-sepolia.flashbots.net";

// Load ABI from Person A's config (shared file)
const ABI_PATH = path.resolve(__dirname, "../../aave-flashbot-bot/config/abi.json");
const ABI = JSON.parse(fs.readFileSync(ABI_PATH, "utf-8"));

// Gas settings
const GAS_LIMIT = 600_000;
const PRIORITY_FEE_GWEI = "2"; // 2 gwei priority fee

// ---------------------------------------------------------------------------
// State — shared with dashboard.js
// ---------------------------------------------------------------------------

const state = {
    currentBlock: 0,
    positionsWatched: 0,
    bundlesSent: 0,
    bundlesLanded: 0,
    bundlesFailed: 0,
    lastLiquidation: null,
    lastArbitrage: null,
    lastBackrun: null,
    totalLiquidations: 0,
    totalArbitrages: 0,
    totalBackruns: 0,
    isRunning: false,
    logs: [],
};

function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    state.logs.push(entry);
    // Keep only last 100 log entries
    if (state.logs.length > 100) state.logs.shift();
}

// ---------------------------------------------------------------------------
// Job 1 — Listen for signals
// ---------------------------------------------------------------------------

// Use the shared signal emitter from the server
const signalBus = signalEmitter;

function emitMockLiquidationSignal() {
    const mockSignal = {
        borrower: "0x1000000000000000000000000000000000000000",
        debtAsset: SEPOLIA_USDC,
        collateralAsset: SEPOLIA_WETH,
        maxDebtToRepay: "500000000",
        collateralAmount: "310000000000000000",
        healthFactor: "0.94",
    };

    log("MOCK MODE: Emitting test liquidation signal...");
    log(`   Borrower: ${mockSignal.borrower}`);
    log(`   Debt: USDC ${Number(mockSignal.maxDebtToRepay) / 1e6}`);
    log(`   Collateral: WETH ${Number(mockSignal.collateralAmount) / 1e18}`);
    log(`   Health Factor: ${mockSignal.healthFactor}`);

    signalBus.emit("liquidation", mockSignal);
}

function emitMockArbSignal() {
    const mockSignal = {
        type: "arbitrage",
        tokenIn: SEPOLIA_WETH,
        tokenOut: SEPOLIA_USDC,
        amountIn: ethers.parseEther("0.05").toString(),
        buyOnUniswap: true,
        uniswapFee: 3000,
        expectedProfitRaw: "100000000000000",
    };

    log("MOCK MODE: Emitting test arbitrage signal...");
    log(`   Token In: ${mockSignal.tokenIn}`);
    log(`   Token Out: ${mockSignal.tokenOut}`);
    log(`   Amount: ${ethers.formatEther(mockSignal.amountIn)} WETH`);
    log(`   Buy DEX:   ${mockSignal.buyOnUniswap ? "Uniswap V3" : "Sushiswap V2"}`);
    log(`   Uni fee:   ${mockSignal.uniswapFee / 100}%`);

    signalBus.emit("arbitrage", mockSignal);
}

function emitMockBackrunSignal() {
    const mockSignal = {
        txHash: "0x" + "ab".repeat(32),
        to: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        value: ethers.parseEther("2.0").toString(),
        valueEth: 2.0,
        gasPrice: ethers.parseUnits("20", "gwei").toString(),
        from: "0x" + "de".repeat(20),
        data: "0x",
        tokenIn: SEPOLIA_WETH,
        tokenOut: SEPOLIA_USDC,
        amountIn: ethers.parseEther("2.0").toString(),
        buyOnUniswap: false,
        uniswapFee: 3000,
    };

    log("MOCK MODE: Emitting test backrun signal...");
    log(`   Target Tx: ${mockSignal.txHash.slice(0, 12)}...`);
    log(`   Value:     ${mockSignal.valueEth} ETH`);
    log(`   Token In:  ${mockSignal.tokenIn}`);
    log(`   Token Out: ${mockSignal.tokenOut}`);

    signalBus.emit("backrun", mockSignal);
}

// ---------------------------------------------------------------------------
// Job 2 — Encode the transaction (supports both strategies)
// ---------------------------------------------------------------------------

const iface = new ethers.Interface(ABI);

function encodeLiquidationTx(signal) {
    const minProfit = 0;

    return iface.encodeFunctionData("executeLiquidation", [
        signal.collateralAsset,
        signal.debtAsset,
        signal.borrower,
        signal.maxDebtToRepay,
        false, // receiveAToken
        minProfit,
    ]);
}

function encodeArbitrageTx(signal) {
    const minProfit = 0;

    return iface.encodeFunctionData("executeArbitrage", [
        signal.tokenIn,
        signal.tokenOut,
        signal.amountIn,
        signal.buyOnUniswap,
        signal.uniswapFee,
        minProfit,
    ]);
}

function encodeBackrunTx(signal) {
    const minProfit = 0;

    return iface.encodeFunctionData("executeBackrun", [
        signal.tokenIn,
        signal.tokenOut,
        signal.amountIn,
        signal.buyOnUniswap,
        signal.uniswapFee,
        minProfit,
        signal.txHash, // bytes32 — identifies which tx we backran
    ]);
}

// ---------------------------------------------------------------------------
// Job 3 — Simulate via Flashbots before sending
// ---------------------------------------------------------------------------

async function simulateBundle(flashbotsProvider, signedBundle, targetBlock) {
    log(` Simulating bundle for block ${targetBlock}...`);

    const simulation = await flashbotsProvider.simulate(signedBundle, targetBlock);

    if ("error" in simulation) {
        log(` Simulation FAILED: ${simulation.error.message}`);
        return null;
    }

    const result = simulation.results[0];
    if (result.error) {
        log(` Simulation reverted: ${result.error}`);
        log(`   Revert reason: ${result.revert || "unknown"}`);
        return null;
    }

    log(` Simulation OK`);
    log(`   Gas used: ${result.gasUsed}`);
    log(`   Coinbase diff: ${ethers.formatEther(simulation.coinbaseDiff)} ETH`);

    return simulation;
}

// ---------------------------------------------------------------------------
// Job 4 & 5 — Build, sign, and send the bundle (strategy-agnostic)
// ---------------------------------------------------------------------------

async function buildAndSendBundle(
    calldata,
    strategyName,
    profitAnalysis,
    signal,
    wallet,
    provider,
    flashbotsProvider
) {
    const block = await provider.getBlock("latest");
    const baseFee = block.baseFeePerGas;
    const priorityFee = ethers.parseUnits(PRIORITY_FEE_GWEI, "gwei");
    const maxFeePerGas = baseFee * 2n + priorityFee;
    const currentBlock = block.number;

    state.currentBlock = currentBlock;

    log(`  Building ${strategyName} bundle...`);
    log(`   Contract: ${CONTRACT_ADDRESS}`);
    log(`   BaseFee: ${ethers.formatUnits(baseFee, "gwei")} gwei`);
    log(`   MaxFeePerGas: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);

    const targetBlocks = [currentBlock + 1, currentBlock + 2];

    for (const targetBlock of targetBlocks) {
        const bundleTransactions = [
            {
                signer: wallet,
                transaction: {
                    to: CONTRACT_ADDRESS,
                    data: calldata,
                    gasLimit: GAS_LIMIT,
                    maxFeePerGas: maxFeePerGas,
                    maxPriorityFeePerGas: priorityFee,
                    chainId: SEPOLIA_CHAIN_ID,
                    type: 2,
                },
            },
        ];

        if (process.env.DEMO_BYPASS_FLASHBOTS === "true") {
            log(`\n 🚀 [RELAY] Sending bundle directly to local Anvil fork...`);
            let lastHash = "0x" + "a1b2c3d4".repeat(8);
            try {
                const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
                for (const signedTx of signedBundle) {
                    const txResponse = await provider.sendTransaction(signedTx);
                    const receipt = await txResponse.wait();
                    log(`   Tx mined in block ${receipt.blockNumber} (Gas: ${receipt.gasUsed})`);
                    lastHash = txResponse.hash;
                }
                log(` 💰 [SUCCESS] ${strategyName.toUpperCase()} genuinely executed ON-CHAIN!`);
            } catch (err) {
                log(`   ❌ Local execution failed: ${err.message}`);
                return;
            }

            state.bundlesSent++;
            state.bundlesLanded++;
            if (strategyName === "liquidation") {
                state.totalLiquidations++;
                state.lastLiquidation = {
                    timestamp: new Date().toISOString(),
                    targetBlock,
                    borrower: signal.borrower,
                    profitETH: profitAnalysis.netProfitETH,
                    bundleHash: lastHash,
                };
            } else if (strategyName === "arbitrage") {
                state.totalArbitrages++;
                state.lastArbitrage = {
                    timestamp: new Date().toISOString(),
                    targetBlock,
                    tokenIn: signal.tokenIn,
                    tokenOut: signal.tokenOut,
                    profitETH: profitAnalysis.netProfitETH,
                    bundleHash: lastHash,
                };
            }
            return;
        }

        const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
        const simulation = await simulateBundle(flashbotsProvider, signedBundle, targetBlock);

        if (!simulation) {
            log(`  Skipping block ${targetBlock} — simulation failed`);
            state.bundlesFailed++;
            continue;
        }

        log(` Sending bundle for block ${targetBlock}...`);
        const bundleResponse = await flashbotsProvider.sendRawBundle(signedBundle, targetBlock);

        if ("error" in bundleResponse) {
            log(` Bundle send error: ${bundleResponse.error.message}`);
            state.bundlesFailed++;
            continue;
        }

        state.bundlesSent++;
        log(` Bundle sent! Hash: ${bundleResponse.bundleHash}`);

        const resolution = await bundleResponse.wait();

        switch (resolution) {
            case FlashbotsBundleResolution.BundleIncluded:
                log(` BUNDLE INCLUDED in block ${targetBlock}!`);
                state.bundlesLanded++;

                if (strategyName === "liquidation") {
                    state.totalLiquidations++;
                    state.lastLiquidation = {
                        timestamp: new Date().toISOString(),
                        targetBlock,
                        borrower: signal.borrower,
                        profitETH: profitAnalysis.netProfitETH,
                        bundleHash: bundleResponse.bundleHash,
                    };
                } else if (strategyName === "arbitrage") {
                    state.totalArbitrages++;
                    state.lastArbitrage = {
                        timestamp: new Date().toISOString(),
                        targetBlock,
                        tokenIn: signal.tokenIn,
                        tokenOut: signal.tokenOut,
                        profitETH: profitAnalysis.netProfitETH,
                        bundleHash: bundleResponse.bundleHash,
                    };
                }
                return;

            case FlashbotsBundleResolution.BlockPassedWithoutInclusion:
                log(` Block ${targetBlock} passed without inclusion, trying next...`);
                break;

            case FlashbotsBundleResolution.AccountNonceTooHigh:
                log(` Nonce too high — another tx was mined. Aborting.`);
                return;

            default:
                log(` Unknown resolution: ${resolution}`);
        }
    }

    log(` Bundle was NOT included in any target block.`);
}

// ---------------------------------------------------------------------------
// Backrun-specific bundle builder — 2-tx bundle (target + our backrun)
// ---------------------------------------------------------------------------

async function buildAndSendBackrunBundle(
    targetRawTx,
    calldata,
    profitAnalysis,
    signal,
    wallet,
    provider,
    flashbotsProvider
) {
    const block = await provider.getBlock("latest");
    const baseFee = block.baseFeePerGas;
    const priorityFee = ethers.parseUnits(PRIORITY_FEE_GWEI, "gwei");
    const maxFeePerGas = baseFee * 2n + priorityFee;
    const currentBlock = block.number;

    state.currentBlock = currentBlock;

    log(`  Building backrun bundle...`);
    log(`   Target tx: ${signal.txHash.slice(0, 12)}...`);
    log(`   Contract: ${CONTRACT_ADDRESS}`);
    log(`   BaseFee: ${ethers.formatUnits(baseFee, "gwei")} gwei`);
    log(`   MaxFeePerGas: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);

    const targetBlocks = [currentBlock + 1, currentBlock + 2];

    for (const targetBlock of targetBlocks) {
        // Bundle ordering matters: target tx executes FIRST (creates price impact),
        // our backrun tx executes SECOND (captures the profit from that impact).
        const bundleTransactions = [
            { signedTransaction: targetRawTx },
            {
                signer: wallet,
                transaction: {
                    to: CONTRACT_ADDRESS,
                    data: calldata,
                    gasLimit: GAS_LIMIT,
                    maxFeePerGas: maxFeePerGas,
                    maxPriorityFeePerGas: priorityFee,
                    chainId: SEPOLIA_CHAIN_ID,
                    type: 2,
                },
            },
        ];

        if (process.env.DEMO_BYPASS_FLASHBOTS === "true") {
            log(`\n 🚀 [RELAY] Sending backrun bundle directly to local Anvil fork...`);
            let lastHash = "0x" + "a1b2c3d4".repeat(8);
            try {
                const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
                for (const signedTx of signedBundle) {
                    const txResponse = await provider.sendTransaction(signedTx);
                    const receipt = await txResponse.wait();
                    log(`   Tx mined in block ${receipt.blockNumber} (Gas: ${receipt.gasUsed})`);
                    lastHash = txResponse.hash;
                }
                log(` 💰 [SUCCESS] BACKRUN genuinely executed ON-CHAIN!`);
            } catch (err) {
                log(`   ❌ Local execution failed: ${err.message}`);
                return;
            }

            state.bundlesSent++;
            state.bundlesLanded++;
            state.totalBackruns++;
            state.lastBackrun = {
                timestamp: new Date().toISOString(),
                targetBlock,
                targetTxHash: signal.txHash,
                valueEth: signal.valueEth,
                profitETH: profitAnalysis.netProfitETH,
                bundleHash: lastHash,
            };
            return;
        }

        const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
        const simulation = await simulateBundle(flashbotsProvider, signedBundle, targetBlock);

        if (!simulation) {
            log(`  Skipping block ${targetBlock} — simulation failed`);
            state.bundlesFailed++;
            continue;
        }

        log(` Sending backrun bundle for block ${targetBlock}...`);
        const bundleResponse = await flashbotsProvider.sendRawBundle(signedBundle, targetBlock);

        if ("error" in bundleResponse) {
            log(` Bundle send error: ${bundleResponse.error.message}`);
            state.bundlesFailed++;
            continue;
        }

        state.bundlesSent++;
        log(` Backrun bundle sent! Hash: ${bundleResponse.bundleHash}`);

        const resolution = await bundleResponse.wait();

        switch (resolution) {
            case FlashbotsBundleResolution.BundleIncluded:
                log(` BACKRUN BUNDLE INCLUDED in block ${targetBlock}!`);
                state.bundlesLanded++;
                state.totalBackruns++;
                state.lastBackrun = {
                    timestamp: new Date().toISOString(),
                    targetBlock,
                    targetTxHash: signal.txHash,
                    valueEth: signal.valueEth,
                    profitETH: profitAnalysis.netProfitETH,
                    bundleHash: bundleResponse.bundleHash,
                };
                return;

            case FlashbotsBundleResolution.BlockPassedWithoutInclusion:
                log(` Block ${targetBlock} passed without inclusion, trying next...`);
                break;

            case FlashbotsBundleResolution.AccountNonceTooHigh:
                log(` Nonce too high — another tx was mined. Aborting.`);
                return;

            default:
                log(` Unknown resolution: ${resolution}`);
        }
    }

    log(` Backrun bundle was NOT included in any target block.`);
}

// ---------------------------------------------------------------------------
// Main pipelines — one per strategy
// ---------------------------------------------------------------------------

async function handleLiquidationSignal(signal, wallet, provider, flashbotsProvider) {
    log(`\n${"=".repeat(60)}`);
    log(` LIQUIDATION SIGNAL RECEIVED`);
    log(`   Borrower: ${signal.borrower}`);
    log(`   Debt Asset: ${signal.debtAsset}`);
    log(`   Collateral Asset: ${signal.collateralAsset}`);
    log(`   Health Factor: ${signal.healthFactor}`);
    log(`${"=".repeat(60)}`);

    try {
        log(` Calculating profitability...`);
        const profitAnalysis = await calculateProfit(signal, provider);

        log(`   Gross profit: $${profitAnalysis.grossProfitUSD} (${profitAnalysis.grossProfitETH} ETH)`);
        log(`   Gas cost:     $${profitAnalysis.gasCostUSD} (${profitAnalysis.gasCostETH} ETH)`);
        log(`   Net profit:   $${profitAnalysis.netProfitUSD} (${profitAnalysis.netProfitETH} ETH)`);
        log(`   Builder tip:  ${profitAnalysis.recommendedTipETH} ETH`);
        log(`   Keeper keeps: ${profitAnalysis.keeperProfitETH} ETH`);

        if (!profitAnalysis.isWorthIt) {
            log(`\n NOT PROFITABLE — skipping this liquidation.`);
            return;
        }

        log(`\n PROFITABLE — proceeding to bundle...`);
        const calldata = encodeLiquidationTx(signal);
        await buildAndSendBundle(calldata, "liquidation", profitAnalysis, signal, wallet, provider, flashbotsProvider);
    } catch (err) {
        log(`\n ERROR processing liquidation: ${err.message}`);
        console.error(err);
    }
}

async function handleArbSignal(signal, wallet, provider, flashbotsProvider) {
    log(`\n${"=".repeat(60)}`);
    log(` ARBITRAGE SIGNAL RECEIVED`);
    log(`   Token In: ${signal.tokenIn}`);
    log(`   Token Out: ${signal.tokenOut}`);
    log(`   Amount: ${ethers.formatEther(signal.amountIn)} tokens`);
    log(`   Buy DEX:   ${signal.buyOnUniswap ? "Uniswap V3" : "Sushiswap V2"}`);
    log(`   Uni fee:   ${signal.uniswapFee / 100}%`);
    log(`${"=".repeat(60)}`);

    try {
        log(` Calculating arb profitability...`);
        const profitAnalysis = await calculateArbProfit(
            {
                profitRaw: BigInt(signal.expectedProfitRaw),
                amountIn: BigInt(signal.amountIn),
            },
            provider
        );

        log(`   Gross profit: ${profitAnalysis.grossProfitETH} ETH`);
        log(`   Gas cost:     ${profitAnalysis.gasCostETH} ETH`);
        log(`   Net profit:   ${profitAnalysis.netProfitETH} ETH`);
        log(`   Builder tip:  ${profitAnalysis.recommendedTipETH} ETH`);
        log(`   Keeper keeps: ${profitAnalysis.keeperProfitETH} ETH`);

        if (!profitAnalysis.isWorthIt) {
            log(`\n NOT PROFITABLE — skipping this arbitrage.`);
            return;
        }

        log(`\n PROFITABLE — proceeding to bundle...`);
        const calldata = encodeArbitrageTx(signal);
        await buildAndSendBundle(calldata, "arbitrage", profitAnalysis, signal, wallet, provider, flashbotsProvider);
    } catch (err) {
        log(`\n ERROR processing arbitrage: ${err.message}`);
        console.error(err);
    }
}

async function handleBackrunSignal(signal, wallet, provider, flashbotsProvider) {
    log(`\n${"=".repeat(60)}`);
    log(` BACKRUN SIGNAL RECEIVED`);
    log(`   Target Tx:  ${signal.txHash.slice(0, 12)}...`);
    log(`   Value:      ${signal.valueEth} ETH`);
    log(`   Token In:   ${signal.tokenIn || "unknown"}`);
    log(`   Token Out:  ${signal.tokenOut || "unknown"}`);
    log(`   Amount In:  ${signal.amountIn || "unknown"}`);
    log(`${"=".repeat(60)}`);

    try {
        // We need decoded swap info to build our counter-trade
        if (!signal.tokenIn || !signal.tokenOut || !signal.amountIn) {
            log(` Cannot decode swap details from target tx — skipping.`);
            return;
        }

        // Fetch the raw signed transaction from the mempool.
        // This is needed because the Flashbots bundle must include the
        // exact signed bytes of the target tx as the first entry.
        log(` Fetching raw transaction for ${signal.txHash.slice(0, 12)}...`);
        let targetRawTx;
        try {
            targetRawTx = await provider.send("eth_getRawTransactionByHash", [signal.txHash]);
        } catch (err) {
            log(` Could not fetch raw tx: ${err.message}`);
            log(`   (provider may not support eth_getRawTransactionByHash)`);
            return;
        }

        if (!targetRawTx) {
            log(` Target tx no longer in mempool — already mined or dropped. Skipping.`);
            return;
        }

        // Profit estimation: the backrun captures a fraction of the
        // price impact created by the target swap. We conservatively
        // estimate ~1% of the swap value as recoverable profit.
        log(` Calculating backrun profitability...`);
        const estimatedProfitRaw = BigInt(signal.amountIn) / 100n;
        const profitAnalysis = await calculateArbProfit(
            { profitRaw: estimatedProfitRaw, amountIn: BigInt(signal.amountIn) },
            provider
        );

        log(`   Estimated gross: ${profitAnalysis.grossProfitETH} ETH`);
        log(`   Gas cost:        ${profitAnalysis.gasCostETH} ETH`);
        log(`   Net profit:      ${profitAnalysis.netProfitETH} ETH`);

        if (!profitAnalysis.isWorthIt) {
            log(`\n NOT PROFITABLE — skipping this backrun.`);
            return;
        }

        log(`\n PROFITABLE — proceeding to backrun bundle...`);
        const calldata = encodeBackrunTx(signal);
        await buildAndSendBackrunBundle(
            targetRawTx, calldata, profitAnalysis, signal,
            wallet, provider, flashbotsProvider
        );
    } catch (err) {
        log(`\n ERROR processing backrun: ${err.message}`);
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * initBundler() — sets up provider, wallet, Flashbots relay, and
 * registers signal listeners on the shared emitter.
 * Called by the unified entry point (server/index.js).
 * Does NOT start its own block listener (the server's watcher handles that).
 */
async function initBundler() {
    log(" MEV Bundler initialising (integrated mode)...");
    log(`   Strategies: Liquidation + DEX Arbitrage`);
    log(`   Network: Sepolia (chain ${SEPOLIA_CHAIN_ID})`);
    log(`   Contract: ${CONTRACT_ADDRESS}`);
    log(`   Relay: ${FLASHBOTS_RELAY_SEPOLIA}`);

    // Validate env vars
    const requiredEnvVars = ["SEPOLIA_RPC_URL", "PRIVATE_KEY", "FLASHBOTS_AUTH_KEY"];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            log(`Missing env var: ${envVar}. Check your .env file.`);
            process.exit(1);
        }
    }

    // Connect to Sepolia
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const network = await provider.getNetwork();
    log(`   Connected to chainId: ${network.chainId}`);

    if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        log(`Wrong network! Expected Sepolia (${SEPOLIA_CHAIN_ID}), got ${network.chainId}`);
        process.exit(1);
    }

    // Wallet setup
    const ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log(`   Owner wallet: ${ownerWallet.address}`);

    const relaySigningWallet = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY);
    log(`   Relay signer: ${relaySigningWallet.address}`);

    // Connect to Flashbots relay
    const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        relaySigningWallet,
        FLASHBOTS_RELAY_SEPOLIA,
        "sepolia"
    );
    log(`   Connected to Flashbots relay`);

    // Check owner balance
    const balance = await provider.getBalance(ownerWallet.address);
    log(`   Owner balance: ${ethers.formatEther(balance)} ETH`);

    if (balance === 0n) {
        log(`  WARNING: Owner has 0 ETH — transactions will fail!`);
    }

    // Register signal handlers on the shared emitter
    signalBus.on("liquidation", (signal) => {
        handleLiquidationSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    signalBus.on("arbitrage", (signal) => {
        handleArbSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    signalBus.on("backrun", (signal) => {
        handleBackrunSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    state.isRunning = true;
    log(`\n Bundler is LIVE — listening for signals from watcher...\n`);
}

/**
 * main() — standalone mode. Boots the bundler with its own block listener
 * and optional mock signals. Used when running `node src/bundler.js` directly.
 */
async function main() {
    log(" MEV Bundler starting (standalone mode)...");
    log(`   Strategies: Liquidation + DEX Arbitrage`);
    log(`   Network: Sepolia (chain ${SEPOLIA_CHAIN_ID})`);
    log(`   Contract: ${CONTRACT_ADDRESS}`);
    log(`   Relay: ${FLASHBOTS_RELAY_SEPOLIA}`);

    // Validate env vars
    const requiredEnvVars = ["SEPOLIA_RPC_URL", "PRIVATE_KEY", "FLASHBOTS_AUTH_KEY"];
    for (const envVar of requiredEnvVars) {
        if (!process.env[envVar]) {
            log(`Missing env var: ${envVar}. Check your .env file.`);
            process.exit(1);
        }
    }

    // Connect to Sepolia
    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const network = await provider.getNetwork();
    log(`   Connected to chainId: ${network.chainId}`);

    if (Number(network.chainId) !== SEPOLIA_CHAIN_ID) {
        log(`Wrong network! Expected Sepolia (${SEPOLIA_CHAIN_ID}), got ${network.chainId}`);
        process.exit(1);
    }

    // Wallet setup
    const ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log(`   Owner wallet: ${ownerWallet.address}`);

    const relaySigningWallet = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY);
    log(`   Relay signer: ${relaySigningWallet.address}`);

    // Connect to Flashbots relay
    const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        relaySigningWallet,
        FLASHBOTS_RELAY_SEPOLIA,
        "sepolia"
    );
    log(`   Connected to Flashbots relay`);

    // Check owner balance
    const balance = await provider.getBalance(ownerWallet.address);
    log(`   Owner balance: ${ethers.formatEther(balance)} ETH`);

    if (balance === 0n) {
        log(`  WARNING: Owner has 0 ETH — transactions will fail!`);
    }

    // Register signal handlers — Job 1 (all strategies)
    signalBus.on("liquidation", (signal) => {
        handleLiquidationSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    signalBus.on("arbitrage", (signal) => {
        handleArbSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    signalBus.on("backrun", (signal) => {
        handleBackrunSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    state.isRunning = true;
    log(`\n Bundler is LIVE — listening for liquidation + arbitrage + backrun signals...\n`);

    // Mock modes for testing
    if (process.env.MOCK_MODE === "true") {
        setTimeout(() => emitMockLiquidationSignal(), 2000);
    }
    if (process.env.MOCK_ARB === "true") {
        setTimeout(() => emitMockArbSignal(), 2000);
    }
    if (process.env.MOCK_BACKRUN === "true") {
        setTimeout(() => emitMockBackrunSignal(), 2000);
    }

    // Keep the process alive — track new blocks
    provider.on("block", (blockNumber) => {
        state.currentBlock = blockNumber;
        if (blockNumber % 10 === 0) {
            log(` Block ${blockNumber}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    signalBus,
    state,
    main,
    initBundler,
    handleLiquidationSignal,
    handleArbSignal,
    handleBackrunSignal,
    encodeLiquidationTx,
    encodeArbitrageTx,
    encodeBackrunTx,
    simulateBundle,
    buildAndSendBundle,
    buildAndSendBackrunBundle,
};

// Run if called directly
if (require.main === module) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}
