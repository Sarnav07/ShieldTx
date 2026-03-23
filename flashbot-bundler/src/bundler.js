require("dotenv").config();
const { ethers } = require("ethers");
const { FlashbotsBundleProvider } = require("@flashbots/ethers-provider-bundle");
const signalEmitter = require("../../server/src/signalEmitter");
const { CONTRACT_ADDRESS } = require("./profitCalculator");

const { state, log } = require("./state");
const { TARGET_CHAIN_ID } = require("./executor");
const {
    handleLiquidationSignal,
    handleArbSignal,
    handleBackrunSignal
} = require("./handlers");

const signalBus = signalEmitter;

const FLASHBOTS_RELAY_SEPOLIA = process.env.NETWORK === "mainnet"
    ? "https://relay.flashbots.net"
    : "https://relay-sepolia.flashbots.net";

function emitMockLiquidationSignal() {
    const mockSignal = {
        borrower: "0x1000000000000000000000000000000000000000",
        debtAsset: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
        collateralAsset: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
        maxDebtToRepay: "500000000",
        collateralAmount: "310000000000000000",
        healthFactor: "0.94",
    };

    log("MOCK MODE: Emitting test liquidation signal...");
    signalBus.emit("liquidation", mockSignal);
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
        tokenIn: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
        tokenOut: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8",
        amountIn: ethers.parseEther("2.0").toString(),
        buyOnUniswap: false,
        uniswapFee: 3000,
    };

    log("MOCK MODE: Emitting test backrun signal...");
    signalBus.emit("backrun", mockSignal);
}

async function initBundler() {
    log(" MEV Bundler initialising (integrated mode)...");
    log(`   Strategies: Liquidation + DEX Arbitrage`);
    log(`   Network: Target Chain ${TARGET_CHAIN_ID}`);
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

    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const network = await provider.getNetwork();
    log(`   Connected to chainId: ${network.chainId}`);

    if (Number(network.chainId) !== TARGET_CHAIN_ID) {
        log(`Wrong network! Expected Target Chain (${TARGET_CHAIN_ID}), got ${network.chainId}`);
        process.exit(1);
    }

    const ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log(`   Owner wallet: ${ownerWallet.address}`);
    const relaySigningWallet = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY);
    log(`   Relay signer: ${relaySigningWallet.address}`);

    const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        relaySigningWallet,
        FLASHBOTS_RELAY_SEPOLIA,
        "sepolia"
    );
    log(`   Connected to Flashbots relay`);

    if (process.env.NETWORK === "mainnet") {
        log(`   [demo] Auto-funding wallet with 100 fake ETH on Anvil...`);
        try {
            await provider.send("anvil_setBalance", [ownerWallet.address, "0x56BC75E2D63100000"]);
        } catch (e) {
            log(`   [demo] Failed to auto-fund: ${e.message}`);
        }
    }
    const balance = await provider.getBalance(ownerWallet.address);
    log(`   Owner balance: ${ethers.formatEther(balance)} ETH`);

    if (balance === 0n) {
        log(`  WARNING: Owner has 0 ETH — transactions will fail!`);
    }

    signalBus.on("liquidation", (s) => handleLiquidationSignal(s, ownerWallet, provider, flashbotsProvider));
    signalBus.on("arbitrage", (s) => handleArbSignal(s, ownerWallet, provider, flashbotsProvider));
    signalBus.on("backrun", (s) => handleBackrunSignal(s, ownerWallet, provider, flashbotsProvider));

    state.isRunning = true;
    log(`\n Bundler is LIVE — listening for signals from watcher...\n`);
}

async function main() {
    log(" MEV Bundler starting (standalone mode)...");
    log(`   Strategies: Liquidation + DEX Arbitrage`);
    log(`   Network: Target Chain ${TARGET_CHAIN_ID}`);
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

    const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const network = await provider.getNetwork();
    log(`   Connected to chainId: ${network.chainId}`);

    if (Number(network.chainId) !== TARGET_CHAIN_ID) {
        log(`Wrong network! Expected Target Chain (${TARGET_CHAIN_ID}), got ${network.chainId}`);
        process.exit(1);
    }

    const ownerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log(`   Owner wallet: ${ownerWallet.address}`);

    const relaySigningWallet = new ethers.Wallet(process.env.FLASHBOTS_AUTH_KEY);
    log(`   Relay signer: ${relaySigningWallet.address}`);

    const flashbotsProvider = await FlashbotsBundleProvider.create(
        provider,
        relaySigningWallet,
        FLASHBOTS_RELAY_SEPOLIA,
        "sepolia"
    );
    log(`   Connected to Flashbots relay`);

    if (process.env.NETWORK === "mainnet") {
        log(`   [demo] Auto-funding wallet with 100 fake ETH on Anvil...`);
        try {
            await provider.send("anvil_setBalance", [ownerWallet.address, "0x56BC75E2D63100000"]);
        } catch (e) {
            log(`   [demo] Failed to auto-fund: ${e.message}`);
        }
    }
    const balance = await provider.getBalance(ownerWallet.address);
    log(`   Owner balance: ${ethers.formatEther(balance)} ETH`);

    if (balance === 0n) {
        log(`  WARNING: Owner has 0 ETH — transactions will fail!`);
    }

    signalBus.on("liquidation", (s) => handleLiquidationSignal(s, ownerWallet, provider, flashbotsProvider));
    signalBus.on("arbitrage", (s) => handleArbSignal(s, ownerWallet, provider, flashbotsProvider));
    signalBus.on("backrun", (s) => handleBackrunSignal(s, ownerWallet, provider, flashbotsProvider));

    state.isRunning = true;
    log(`\n Bundler is LIVE --> listening for liquidation + arbitrage + backrun signals...\n`);

    if (process.env.MOCK_MODE === "true") {
        setTimeout(() => emitMockLiquidationSignal(), 2000);
    }
    if (process.env.MOCK_ARB === "true") {
        setTimeout(async () => {
            const { findArbOpportunity, toArbSignal } = require("./arbCalculator");
            const ADDR = {
                WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
            };
            const opp = await findArbOpportunity(provider, ADDR.WETH, ADDR.USDC);
            if (opp) {
                signalBus.emit("arbitrage", toArbSignal(opp));
            } else {
                log("   [demo] No arb opportunity found to mock!");
            }
        }, 2000);
    }
    if (process.env.MOCK_BACKRUN === "true") {
        setTimeout(() => emitMockBackrunSignal(), 2000);
    }

    provider.on("block", (blockNumber) => {
        state.currentBlock = blockNumber;
        if (blockNumber % 10 === 0) {
            log(` Block ${blockNumber}`);
        }
    });
}

module.exports = {
    signalBus,
    state,
    main,
    initBundler
};

if (require.main === module) {
    main().catch((err) => {
        console.error("Fatal error:", err);
        process.exit(1);
    });
}
