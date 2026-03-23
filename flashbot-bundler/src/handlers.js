const { ethers } = require("ethers");
const { log } = require("./state");
const { calculateProfit } = require("./profitCalculator");
const { calculateArbProfit } = require("./arbCalculator");

const {
    encodeLiquidationTx,
    encodeArbitrageTx,
    encodeBackrunTx
} = require("./encoders");

const {
    buildAndSendBundle,
    buildAndSendBackrunBundle
} = require("./executor");

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
        if (!signal.tokenIn || !signal.tokenOut || !signal.amountIn) {
            log(` Cannot decode swap details from target tx — skipping.`);
            return;
        }

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

module.exports = {
    handleLiquidationSignal,
    handleArbSignal,
    handleBackrunSignal
};
