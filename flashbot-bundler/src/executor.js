const { ethers } = require("ethers");
const { FlashbotsBundleResolution } = require("@flashbots/ethers-provider-bundle");
const { state, log } = require("./state");
const { CONTRACT_ADDRESS } = require("./profitCalculator");
const path = require("path");
const fs = require("fs");

const TARGET_CHAIN_ID = process.env.NETWORK === "mainnet" ? 1 : 11155111;
const GAS_LIMIT = 600_000;
const PRIORITY_FEE_GWEI = "2";

function getDynamicContractAddress() {
    if (process.env.NETWORK === "mainnet") {
        try {
            const demoPath = path.resolve(__dirname, "../../.demo-contract.json");
            const cd = JSON.parse(fs.readFileSync(demoPath, "utf-8"));
            return cd.contractAddress;
        } catch {
            return CONTRACT_ADDRESS;
        }
    }
    return CONTRACT_ADDRESS;
}

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
                    to: getDynamicContractAddress(),
                    data: calldata,
                    gasLimit: GAS_LIMIT,
                    maxFeePerGas: maxFeePerGas,
                    maxPriorityFeePerGas: priorityFee,
                    chainId: TARGET_CHAIN_ID,
                    type: 2,
                },
            },
        ];

        if (process.env.DEMO_BYPASS_FLASHBOTS === "true") {
            log(`\n [RELAY] Sending bundle directly to local Anvil fork...`);
            let lastHash = "0x" + "a1b2c3d4".repeat(8);
            try {
                const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
                for (const signedTx of signedBundle) {
                    const txResponse = await provider.broadcastTransaction(signedTx);
                    const receipt = await txResponse.wait();
                    log(`   Tx mined in block ${receipt.blockNumber} (Gas: ${receipt.gasUsed})`);
                    lastHash = txResponse.hash;
                }
                log(` [SUCCESS] ${strategyName.toUpperCase()} genuinely executed ON-CHAIN!`);
            } catch (err) {
                log(`   Local execution failed: ${err.message}`);
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
        const bundleTransactions = [
            { signedTransaction: targetRawTx },
            {
                signer: wallet,
                transaction: {
                    to: getDynamicContractAddress(),
                    data: calldata,
                    gasLimit: GAS_LIMIT,
                    maxFeePerGas: maxFeePerGas,
                    maxPriorityFeePerGas: priorityFee,
                    chainId: TARGET_CHAIN_ID,
                    type: 2,
                },
            },
        ];

        if (process.env.DEMO_BYPASS_FLASHBOTS === "true") {
            log(`\n [RELAY] Sending backrun bundle directly to local Anvil fork...`);
            let lastHash = "0x" + "a1b2c3d4".repeat(8);
            try {
                const signedBundle = await flashbotsProvider.signBundle(bundleTransactions);
                for (const signedTx of signedBundle) {
                    const txResponse = await provider.broadcastTransaction(signedTx);
                    const receipt = await txResponse.wait();
                    log(`   Tx mined in block ${receipt.blockNumber} (Gas: ${receipt.gasUsed})`);
                    lastHash = txResponse.hash;
                }
                log(` [SUCCESS] BACKRUN genuinely executed ON-CHAIN!`);
            } catch (err) {
                log(`   Local execution failed: ${err.message}`);
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

module.exports = {
    TARGET_CHAIN_ID,
    getDynamicContractAddress,
    simulateBundle,
    buildAndSendBundle,
    buildAndSendBackrunBundle
};
