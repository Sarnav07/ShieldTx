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
    totalLiquidations: 0,
    totalArbitrages: 0,
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
    log(`   Buy pool: ${mockSignal.buyFee / 100}% fee tier`);
    log(`   Sell pool: ${mockSignal.sellFee / 100}% fee tier`);

    signalBus.emit("arbitrage", mockSignal);
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
    log(`   Buy pool: ${signal.buyFee / 100}% fee tier`);
    log(`   Sell pool: ${signal.sellFee / 100}% fee tier`);
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

    // Register signal handlers — Job 1 (both strategies)
    signalBus.on("liquidation", (signal) => {
        handleLiquidationSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    signalBus.on("arbitrage", (signal) => {
        handleArbSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    state.isRunning = true;
    log(`\n Bundler is LIVE — listening for liquidation + arbitrage signals...\n`);

    // Mock modes for testing
    if (process.env.MOCK_MODE === "true") {
        setTimeout(() => emitMockLiquidationSignal(), 2000);
    }
    if (process.env.MOCK_ARB === "true") {
        setTimeout(() => emitMockArbSignal(), 2000);
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
    encodeLiquidationTx,
    encodeArbitrageTx,
    simulateBundle,
    buildAndSendBundle,
};

// Run if called directly
if (require.main === module) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}
