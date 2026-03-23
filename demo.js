#!/usr/bin/env node

const { ethers } = require("ethers");

const ADDR = {
    AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    UNI_QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    SUSHI_ROUTER: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const WETH_ABI = [
    "function deposit() payable",
    "function approve(address, uint256) returns (bool)",
];
const QUOTER_ABI = [
    "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)",
];
const SUSHI_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];
const AAVE_POOL_ABI = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
    "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
];

const contractABI = require("./aave-flashbot-bot/config/abi.json");

const FORK_URL = "http://127.0.0.1:8545";
const WHALE = "0x0000000000000000000000000000000000001337";

let provider, whale;

const { parseEther, parseUnits, formatEther, formatUnits } = ethers.utils;

function section(title) {
    console.log(`\n${"━".repeat(62)}`);
    console.log(`  ${title}`);
    console.log(`${"━".repeat(62)}`);
}
function step(n, msg) { console.log(`\n  > Step ${n}: ${msg}`); }
function info(label, value) { console.log(`    ${label.padEnd(22)} ${value}`); }
function success(msg) { console.log(`\n  ${msg}`); }
function fmtEth(bn) { return parseFloat(formatEther(bn)).toFixed(4); }
function fmtUsd(bn, dec = 6) { return parseFloat(formatUnits(bn, dec)).toFixed(2); }

async function getUniPrice(amountIn, fee = 3000) {
    const quoter = new ethers.Contract(ADDR.UNI_QUOTER, QUOTER_ABI, provider);
    return quoter.callStatic.quoteExactInputSingle(ADDR.WETH, ADDR.USDC, fee, amountIn, 0);
}

async function getSushiPrice(amountIn) {
    const sushi = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, provider);
    const amounts = await sushi.getAmountsOut(amountIn, [ADDR.WETH, ADDR.USDC]);
    return amounts[1];
}

async function demoArbitrage() {
    section("DEMO 1 — CROSS-DEX ARBITRAGE");
    console.log("  A whale dumps 200 ETH on Sushiswap V2, crashing the Sushi price.");
    console.log("  The bot detects the Uni/Sushi spread and executes the arb.\n");

    const ONE_ETH = parseEther("1.0");
    const WHALE_SWAP = parseEther("200.0");
    const arbAmount = parseEther("10.0");

    step(1, "Prices before whale swap");
    info("Uniswap V3 (0.3%)", `1 WETH = ${fmtUsd(await getUniPrice(ONE_ETH))} USDC`);
    info("Sushiswap V2", `1 WETH = ${fmtUsd(await getSushiPrice(ONE_ETH))} USDC`);

    step(2, `Whale sells ${fmtEth(WHALE_SWAP)} WETH on Sushiswap V2`);
    const weth = new ethers.Contract(ADDR.WETH, WETH_ABI, whale);
    await weth.deposit({ value: WHALE_SWAP });
    await weth.approve(ADDR.SUSHI_ROUTER, WHALE_SWAP);

    const sushi = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, whale);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await sushi.swapExactTokensForTokens(WHALE_SWAP, 0, [ADDR.WETH, ADDR.USDC], WHALE, deadline);
    info("executed", "200 WETH → USDC on Sushiswap V2");

    step(3, "Prices after whale swap");
    const uniAfter = await getUniPrice(ONE_ETH);
    const sushiAfter = await getSushiPrice(ONE_ETH);
    const uniF = parseFloat(fmtUsd(uniAfter));
    const sushiF = parseFloat(fmtUsd(sushiAfter));
    const spread = (((uniF - sushiF) / sushiF) * 100).toFixed(2);
    info("Uniswap V3 (0.3%)", `1 WETH = ${uniF.toFixed(2)} USDC`);
    info("Sushiswap V2", `1 WETH = ${sushiF.toFixed(2)} USDC  (crashed)`);
    info("cross-dex spread", `${spread}%`);

    step(4, "Bot scans both routes");
    const sushiRouter = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, provider);
    const quoter = new ethers.Contract(ADDR.UNI_QUOTER, QUOTER_ABI, provider);

    const leg1A = await getUniPrice(arbAmount, 3000);
    const amountsA = await sushiRouter.getAmountsOut(leg1A, [ADDR.USDC, ADDR.WETH]);
    const profitA = amountsA[1].sub(arbAmount);

    const amountsB1 = await sushiRouter.getAmountsOut(arbAmount, [ADDR.WETH, ADDR.USDC]);
    const leg2B = await quoter.callStatic.quoteExactInputSingle(ADDR.USDC, ADDR.WETH, 3000, amountsB1[1], 0);
    const profitB = leg2B.sub(arbAmount);

    const buyOnUniswap = profitA.gt(profitB);
    const bestProfit = buyOnUniswap ? profitA : profitB;

    info("Route A (Uni→Sushi)", `${fmtEth(profitA)} ETH profit`);
    info("Route B (Sushi→Uni)", `${fmtEth(profitB)} ETH profit`);
    info("selected route", `${buyOnUniswap ? "A" : "B"} — buyOnUniswap=${buyOnUniswap}`);

    step(5, "Encoding executeArbitrage() for Flashbots bundle");
    const iface = new ethers.utils.Interface(contractABI);
    const calldata = iface.encodeFunctionData("executeArbitrage", [
        ADDR.WETH, ADDR.USDC, arbAmount, buyOnUniswap, 3000, 0,
    ]);
    info("function", "executeArbitrage()");
    info("calldata", `${calldata.slice(0, 20)}...${calldata.slice(-8)} (${calldata.length / 2 - 1} bytes)`);
    info("net profit", `${fmtEth(bestProfit)} ETH ($${(parseFloat(fmtEth(bestProfit)) * uniF).toFixed(2)})`);

    success(bestProfit.gt(0)
        ? `arb profitable — ${fmtEth(bestProfit)} ETH on a 10 ETH trade`
        : `spread detected (${spread}%) — round-trip not profitable at this size`
    );
}

async function demoLiquidation() {
    section("DEMO 2 — AAVE V3 LIQUIDATION");
    console.log("  The bot monitors Aave borrowers. When a position's Health Factor");
    console.log("  drops below 1.0, it flash-loans the debt, liquidates, and pockets");
    console.log("  the 5% liquidation bonus.\n");

    step(1, "Creating a test borrower on Aave V3");
    const supplyAmount = parseEther("5.0");
    const weth = new ethers.Contract(ADDR.WETH, WETH_ABI, whale);
    await weth.deposit({ value: supplyAmount });
    await weth.approve(ADDR.AAVE_POOL, supplyAmount);

    const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, whale);
    await pool.supply(ADDR.WETH, supplyAmount, WHALE, 0);
    info("supplied", `${fmtEth(supplyAmount)} WETH as collateral`);

    let accountData = await pool.getUserAccountData(WHALE);
    const maxBorrowUSD = parseFloat(formatUnits(accountData.availableBorrowsBase, 8));
    info("max borrow", `$${maxBorrowUSD.toFixed(2)}`);

    const borrowBase = accountData.availableBorrowsBase.mul(95).div(100);
    const borrowUSDC = borrowBase.mul(1000000).div(100000000);
    await pool.borrow(ADDR.USDC, borrowUSDC, 2, 0, WHALE);
    info("borrowed", `${fmtUsd(borrowUSDC)} USDC (95% of max)`);

    step(2, "Health factor check");
    accountData = await pool.getUserAccountData(WHALE);
    const collateralUSD = parseFloat(formatUnits(accountData.totalCollateralBase, 8));
    const debtUSD = parseFloat(formatUnits(accountData.totalDebtBase, 8));
    const hf = parseFloat(formatUnits(accountData.healthFactor, 18));
    info("collateral", `$${collateralUSD.toFixed(2)}`);
    info("debt", `$${debtUSD.toFixed(2)}`);
    info("health factor", `${hf.toFixed(4)}${hf < 1.05 ? "  DANGER" : ""}`);
    info("LTV", `${((debtUSD / collateralUSD) * 100).toFixed(1)}%`);

    step(3, "Liquidation profit estimate");
    const maxRepay = debtUSD * 0.5;
    const collateralSeized = maxRepay * 1.05;
    const flashLoanFee = maxRepay * 0.0005;
    const gasCostUSD = 0.015 * collateralUSD / 5;
    const grossProfit = collateralSeized - maxRepay;
    const netProfit = grossProfit - flashLoanFee - gasCostUSD;
    info("max repayable (50%)", `$${maxRepay.toFixed(2)}`);
    info("collateral seized", `$${collateralSeized.toFixed(2)} (5% bonus)`);
    info("flash loan fee (0.05%)", `$${flashLoanFee.toFixed(2)}`);
    info("est. gas", `~$${gasCostUSD.toFixed(2)}`);
    info("gross profit", `$${grossProfit.toFixed(2)}`);
    info("net profit", `$${netProfit.toFixed(2)}`);

    step(4, "Encoding executeLiquidation() for Flashbots bundle");
    const iface = new ethers.utils.Interface(contractABI);
    const calldata = iface.encodeFunctionData("executeLiquidation", [
        ADDR.WETH, ADDR.USDC, WHALE, borrowUSDC.div(2), false, 0,
    ]);
    info("function", "executeLiquidation()");
    info("target", `${WHALE.slice(0, 10)}...`);
    info("calldata", `${calldata.slice(0, 20)}...${calldata.slice(-8)} (${calldata.length / 2 - 1} bytes)`);

    success(`position created at HF ${hf.toFixed(4)} — liquidatable when HF < 1.0`);
}

async function main() {
    console.log("\nShieldTx — hackathon demo");
    console.log("arbitrage + liquidation on Anvil mainnet fork\n");

    try {
        provider = new ethers.providers.JsonRpcProvider(FORK_URL);
        const block = await provider.getBlockNumber();
        const network = await provider.getNetwork();
        console.log(`connected — block ${block}, chain ${network.chainId}`);
    } catch {
        console.error("cannot connect to Anvil — run: anvil --fork-url $MAINNET_RPC_URL --port 8545");
        process.exit(1);
    }

    await provider.send("anvil_setBalance", [WHALE, ethers.utils.hexValue(parseEther("10000"))]);
    await provider.send("anvil_impersonateAccount", [WHALE]);
    whale = provider.getSigner(WHALE);

    await demoArbitrage();
    await demoLiquidation();

    console.log(`\n${"━".repeat(62)}`);
    console.log("  demo complete");
    console.log(`${"━".repeat(62)}`);
    console.log("\n  arbitrage   — cross-dex price manipulation + bundle encoding");
    console.log("  liquidation — aave V3 position creation + profit analysis");
    console.log("\n  dashboard:  http://localhost:3000\n");

    process.exit(0);
}

main().catch((err) => {
    console.error("demo failed:", err.message);
    process.exit(1);
});