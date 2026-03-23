const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const ABI_PATH = path.resolve(__dirname, "../../aave-flashbot-bot/config/abi.json");
const ABI = JSON.parse(fs.readFileSync(ABI_PATH, "utf-8"));
const iface = new ethers.Interface(ABI);

function encodeLiquidationTx(signal) {
    const minProfit = 0;
    return iface.encodeFunctionData("executeLiquidation", [
        signal.collateralAsset,
        signal.debtAsset,
        signal.borrower,
        signal.maxDebtToRepay,
        false,
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
        signal.txHash,
    ]);
}

module.exports = {
    encodeLiquidationTx,
    encodeArbitrageTx,
    encodeBackrunTx
};
