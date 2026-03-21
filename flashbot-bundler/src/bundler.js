/**
 * bundler.js
 *
 * Core engine for Person C — the Flashbots integration layer.
 *
 * 5 Jobs:
 *   1. Listen for liquidation signals from Person B's watcher
 *   2. Encode the executeLiquidation() transaction using Person A's ABI
 *   3. Simulate via Flashbots eth_callBundle before sending
 *   4. Calculate builder tip and build the bundle for block N and N+1
 *   5. Sign and send via FlashbotsBundleProvider
 *
 * Usage:
 *   node src/bundler.js                          — runs with live watcher
 *   MOCK_MODE=true node src/bundler.js           — runs with a mock signal for testing
 */

require("dotenv").config();
const { ethers } = require("ethers");
const {
    FlashbotsBundleProvider,
    FlashbotsBundleResolution,
} = require("@flashbots/ethers-provider-bundle");
const { EventEmitter } = require("events");
const path = require("path");
const fs = require("fs");

const { calculateProfit, CONTRACT_ADDRESS, CONFIG } = require("./profitCalculator");

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
// Job 1 — Listen for liquidation signals
// ---------------------------------------------------------------------------

/**
 * The signal bus. Person B's watcher emits "liquidation" events on this.
 * If running in separate processes, replace EventEmitter with a WebSocket
 * or Redis pub/sub connection.
 */
const signalBus = new EventEmitter();

/**
 * Mock signal for local testing — use when Person B's watcher isn't ready.
 * Run with MOCK_MODE=true to fire a test signal after startup.
 *
 * Signal shape (agreed with Person B):
 * {
 *   borrower:         "0x...",   — the underwater user
 *   debtAsset:        "0x...",   — token they borrowed (e.g., USDC)
 *   collateralAsset:  "0x...",   — token they put up (e.g., WETH)
 *   maxDebtToRepay:   "...",     — raw amount in smallest unit
 *   collateralAmount: "...",     — estimated collateral to seize
 *   healthFactor:     "0.94"     — for logging
 * }
 */
function emitMockSignal() {
    const mockSignal = {
        borrower: "0x1000000000000000000000000000000000000000",
        debtAsset: "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8",      // USDC on Sepolia
        collateralAsset: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",  // WETH on Sepolia
        maxDebtToRepay: "500000000",          // 500 USDC (6 decimals)
        collateralAmount: "310000000000000000", // 0.31 WETH (18 decimals)
        healthFactor: "0.94",
    };

    log("🧪 MOCK MODE: Emitting test liquidation signal...");
    log(`   Borrower: ${mockSignal.borrower}`);
    log(`   Debt: USDC ${Number(mockSignal.maxDebtToRepay) / 1e6}`);
    log(`   Collateral: WETH ${Number(mockSignal.collateralAmount) / 1e18}`);
    log(`   Health Factor: ${mockSignal.healthFactor}`);

    signalBus.emit("liquidation", mockSignal);
}

// ---------------------------------------------------------------------------
// Job 2 — Encode the transaction
// ---------------------------------------------------------------------------

/**
 * Encodes the executeLiquidation() call using Person A's contract ABI.
 *
 * @param {object} signal - liquidation signal from Person B
 * @param {object} profitAnalysis - output from profitCalculator
 * @returns {string} ABI-encoded calldata
 */
function encodeLiquidationTx(signal, profitAnalysis) {
    const iface = new ethers.Interface(ABI);

    // Convert recommended tip to a minProfit value in the debt token's units.
    // The contract reverts if leftover profit < minProfit, so we set it
    // conservatively to 0 for hackathon testing. 
    // In production: set this to the minimum acceptable raw token amount.
    const minProfit = 0;

    // Uniswap V3 pool fee tier — 3000 = 0.3%
    const poolFee = 3000;

    const calldata = iface.encodeFunctionData("executeLiquidation", [
        signal.collateralAsset,
        signal.debtAsset,
        signal.borrower,
        signal.maxDebtToRepay,
        false,       // receiveAToken = false (receive underlying collateral)
        minProfit,
        poolFee,
    ]);

    return calldata;
}

// ---------------------------------------------------------------------------
// Job 3 — Simulate via Flashbots before sending
// ---------------------------------------------------------------------------

/**
 * Simulates the bundle against the current block to check if it would revert.
 *
 * @param {FlashbotsBundleProvider} flashbotsProvider
 * @param {object} signedBundle - the signed bundle transactions
 * @param {number} targetBlock - the block number to simulate against
 * @returns {Promise<object|null>} simulation result, or null if failed
 */
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
// Job 4 & 5 — Build, sign, and send the bundle
// ---------------------------------------------------------------------------

/**
 * Builds, signs, and sends a Flashbots bundle targeting block N and N+1.
 *
 * @param {object} signal - liquidation signal
 * @param {object} profitAnalysis - from profitCalculator
 * @param {ethers.Wallet} wallet - the contract owner wallet (signs the tx)
 * @param {ethers.Provider} provider - JSON-RPC provider
 * @param {FlashbotsBundleProvider} flashbotsProvider - Flashbots relay connection
 */
async function buildAndSendBundle(
    signal,
    profitAnalysis,
    wallet,
    provider,
    flashbotsProvider
) {
    const calldata = encodeLiquidationTx(signal, profitAnalysis);

    // Get current gas values
    const block = await provider.getBlock("latest");
    const baseFee = block.baseFeePerGas;
    const priorityFee = ethers.parseUnits(PRIORITY_FEE_GWEI, "gwei");
    const maxFeePerGas = baseFee * 2n + priorityFee; // 2x baseFee buffer for next block
    const currentBlock = block.number;

    state.currentBlock = currentBlock;

    log(`  Building bundle...`);
    log(`   Contract: ${CONTRACT_ADDRESS}`);
    log(`   BaseFee: ${ethers.formatUnits(baseFee, "gwei")} gwei`);
    log(`   MaxFeePerGas: ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);

    // Target two consecutive blocks for latency tolerance
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

        // ---- Job 3: Simulate first ----
        const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
        const simulation = await simulateBundle(
            flashbotsProvider,
            signedBundle,
            targetBlock
        );

        if (!simulation) {
            log(`  Skipping block ${targetBlock} — simulation failed`);
            state.bundlesFailed++;
            continue;
        }

        // ---- Job 5: Send the bundle ----
        log(` Sending bundle for block ${targetBlock}...`);
        const bundleResponse = await flashbotsProvider.sendRawBundle(
            signedBundle,
            targetBlock
        );

        if ("error" in bundleResponse) {
            log(` Bundle send error: ${bundleResponse.error.message}`);
            state.bundlesFailed++;
            continue;
        }

        state.bundlesSent++;
        log(` Bundle sent! Hash: ${bundleResponse.bundleHash}`);

        // Wait for the bundle to be included (or not)
        const resolution = await bundleResponse.wait();

        switch (resolution) {
            case FlashbotsBundleResolution.BundleIncluded:
                log(` BUNDLE INCLUDED in block ${targetBlock}!`);
                state.bundlesLanded++;
                state.lastLiquidation = {
                    timestamp: new Date().toISOString(),
                    targetBlock,
                    borrower: signal.borrower,
                    profitETH: profitAnalysis.netProfitETH,
                    profitUSD: profitAnalysis.netProfitUSD,
                    bundleHash: bundleResponse.bundleHash,
                };
                return; // done — no need to try the next block

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
// Main pipeline — ties all 5 jobs together
// ---------------------------------------------------------------------------

async function handleSignal(signal, wallet, provider, flashbotsProvider) {
    log(`\n${"=".repeat(60)}`);
    log(` LIQUIDATION SIGNAL RECEIVED`);
    log(`   Borrower: ${signal.borrower}`);
    log(`   Debt Asset: ${signal.debtAsset}`);
    log(`   Collateral Asset: ${signal.collateralAsset}`);
    log(`   Health Factor: ${signal.healthFactor}`);
    log(`${"=".repeat(60)}`);

    try {
        // Step 1: Check profitability
        log(`\ Calculating profitability...`);
        const profitAnalysis = await calculateProfit(signal, provider);

        log(`   Gross profit: $${profitAnalysis.grossProfitUSD} (${profitAnalysis.grossProfitETH} ETH)`);
        log(`   Gas cost:     $${profitAnalysis.gasCostUSD} (${profitAnalysis.gasCostETH} ETH)`);
        log(`   Net profit:   $${profitAnalysis.netProfitUSD} (${profitAnalysis.netProfitETH} ETH)`);
        log(`   Builder tip:  ${profitAnalysis.recommendedTipETH} ETH`);
        log(`   Keeper keeps: ${profitAnalysis.keeperProfitETH} ETH`);

        if (!profitAnalysis.isWorthIt) {
            log(`\n NOT PROFITABLE — skipping this liquidation.`);
            log(`   Net profit ${profitAnalysis.netProfitETH} ETH < threshold ${CONFIG.MIN_PROFIT_THRESHOLD_ETH} ETH`);
            return;
        }

        log(`\n PROFITABLE — proceeding to bundle...`);

        // Step 2–5: Encode, simulate, build, send
        await buildAndSendBundle(signal, profitAnalysis, wallet, provider, flashbotsProvider);
    } catch (err) {
        log(`\n ERROR processing signal: ${err.message}`);
        console.error(err);
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
    log(" Aave Flashbot Bundler starting...");
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

    // Wallet setup — two separate keys for two separate purposes
    // PRIVATE_KEY = contract owner, signs the actual liquidation tx
    const ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log(`   Owner wallet: ${ownerWallet.address}`);

    // FLASHBOTS_AUTH_KEY = relay signing key, identifies you to the Flashbots relay
    // This is NOT your money key — it's a throwaway key for relay authentication
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

    // Register signal handler (Job 1)
    signalBus.on("liquidation", (signal) => {
        handleSignal(signal, ownerWallet, provider, flashbotsProvider);
    });

    state.isRunning = true;
    log(`\n Bundler is LIVE — listening for liquidation signals...\n`);

    // If running in mock mode, fire a test signal after 2 seconds
    if (process.env.MOCK_MODE === "true") {
        setTimeout(() => emitMockSignal(), 2000);
    }

    // Keep the process alive — track new blocks
    provider.on("block", (blockNumber) => {
        state.currentBlock = blockNumber;
        // Log every 10th block to avoid spam
        if (blockNumber % 10 === 0) {
            log(` Block ${blockNumber}`);
        }
    });
}

// ---------------------------------------------------------------------------
// Exports — signalBus and state are shared with watcher and dashboard
// ---------------------------------------------------------------------------

module.exports = {
    signalBus,
    state,
    handleSignal,
    encodeLiquidationTx,
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
