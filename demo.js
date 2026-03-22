#!/usr/bin/env node
/**
 * demo.js — ShieldTx Hackathon Demo
 *
 * Demonstrates all 4 MEV strategies on an Anvil mainnet fork:
 *   1. Arbitrage   — Real whale swap creates price discrepancy, bot detects it
 *   2. Liquidation — Real Aave V3 position created, HF analysis + profit calc
 *   3. Backrun     — Simulated large mempool swap decoded and bundled
 *   4. Protection  — Simulated user rescue calculation
 *
 * Usage:
 *   anvil --fork-url $MAINNET_RPC_URL --port 8545 &
 *   node demo.js
 */

const { ethers } = require("ethers");

// ─── Mainnet Addresses (exist on the Anvil fork) ─────────────────────
const ADDR = {
    AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    AAVE_ORACLE: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
    UNI_QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    SUSHI_ROUTER: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

// ─── ABIs ─────────────────────────────────────────────────────────────
const WETH_ABI = [
    "function deposit() payable",
    "function approve(address, uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
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
const AAVE_ORACLE_ABI = [
    "function getAssetPrice(address asset) view returns (uint256)",
];

// Contract ABI for encoding demo
const contractABI = require("./aave-flashbot-bot/config/abi.json");

const FORK_URL = "http://127.0.0.1:8545";
const WHALE = "0x0000000000000000000000000000000000001337";

let provider, whale;

// ─── Helpers (ethers v5) ──────────────────────────────────────────────
const { parseEther, parseUnits, formatEther, formatUnits } = ethers.utils;

function section(title) {
    console.log(`\n${"━".repeat(62)}`);
    console.log(`  ${title}`);
    console.log(`${"━".repeat(62)}`);
}
function step(n, msg) { console.log(`\n  ▸ Step ${n}: ${msg}`); }
function info(label, value) { console.log(`    ${label.padEnd(22)} ${value}`); }
function success(msg) { console.log(`\n  ✅ ${msg}`); }
function fmtEth(bn) { return parseFloat(formatEther(bn)).toFixed(4); }
function fmtUsd(bn, dec = 6) { return parseFloat(formatUnits(bn, dec)).toFixed(2); }

async function getUniPrice(amountIn, fee = 3000) {
    const quoter = new ethers.Contract(ADDR.UNI_QUOTER, QUOTER_ABI, provider);
    const amountOut = await quoter.callStatic.quoteExactInputSingle(
        ADDR.WETH, ADDR.USDC, fee, amountIn, 0
    );
    return amountOut;
}

async function getSushiPrice(amountIn) {
    const sushi = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, provider);
    const amounts = await sushi.getAmountsOut(amountIn, [ADDR.WETH, ADDR.USDC]);
    return amounts[1];
}

// ═══════════════════════════════════════════════════════════════════════
// DEMO 1 — ARBITRAGE: Real cross-DEX price manipulation + detection
// ═══════════════════════════════════════════════════════════════════════
async function demoArbitrage() {
    section("DEMO 1 — CROSS-DEX ARBITRAGE");
    console.log("  Scenario: A whale dumps 200 ETH on Sushiswap V2, crashing the");
    console.log("  Sushi price. Our bot detects the Uni↔Sushi spread and arbs it.\n");

    const ONE_ETH = parseEther("1.0");
    const WHALE_SWAP = parseEther("200.0");

    // Step 1: Show current prices
    step(1, "Current market prices (before whale swap)");
    const uniPriceBefore = await getUniPrice(ONE_ETH);
    const sushiPriceBefore = await getSushiPrice(ONE_ETH);
    info("Uniswap V3 (0.3%)", `1 WETH = ${fmtUsd(uniPriceBefore)} USDC`);
    info("Sushiswap V2", `1 WETH = ${fmtUsd(sushiPriceBefore)} USDC`);

    // Step 2: Whale dumps on Sushi
    step(2, `Whale sells ${fmtEth(WHALE_SWAP)} WETH on Sushiswap V2...`);
    const weth = new ethers.Contract(ADDR.WETH, WETH_ABI, whale);
    await weth.deposit({ value: WHALE_SWAP });
    await weth.approve(ADDR.SUSHI_ROUTER, WHALE_SWAP);

    const sushi = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, whale);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await sushi.swapExactTokensForTokens(
        WHALE_SWAP, 0, [ADDR.WETH, ADDR.USDC], WHALE, deadline
    );
    info("Swap executed", "200 WETH → USDC on Sushiswap V2");

    // Step 3: Show post-swap prices
    step(3, "Market prices AFTER whale swap");
    const uniPriceAfter = await getUniPrice(ONE_ETH);
    const sushiPriceAfter = await getSushiPrice(ONE_ETH);
    const uniF = parseFloat(fmtUsd(uniPriceAfter));
    const sushiF = parseFloat(fmtUsd(sushiPriceAfter));
    const spread = (((uniF - sushiF) / sushiF) * 100).toFixed(2);
    info("Uniswap V3 (0.3%)", `1 WETH = ${uniF.toFixed(2)} USDC  (unchanged)`);
    info("Sushiswap V2", `1 WETH = ${sushiF.toFixed(2)} USDC  (CRASHED)`);
    info("Cross-DEX Spread", `${spread}%  🔥`);

    // Step 4: Our bot detects the arb
    step(4, "ShieldTx arb scanner detects the opportunity...");

    const arbAmount = parseEther("10.0");

    // Route A: Buy on Uni V3 → Sell on Sushi V2
    const leg1A = await getUniPrice(arbAmount, 3000);
    const sushiRouterInstance = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, provider);
    const amountsA = await sushiRouterInstance.getAmountsOut(leg1A, [ADDR.USDC, ADDR.WETH]);
    const profitA = amountsA[1].sub(arbAmount);

    // Route B: Buy on Sushi V2 → Sell on Uni V3
    const amountsB1 = await sushiRouterInstance.getAmountsOut(arbAmount, [ADDR.WETH, ADDR.USDC]);
    const quoter = new ethers.Contract(ADDR.UNI_QUOTER, QUOTER_ABI, provider);
    const leg2B = await quoter.callStatic.quoteExactInputSingle(
        ADDR.USDC, ADDR.WETH, 3000, amountsB1[1], 0
    );
    const profitB = leg2B.sub(arbAmount);

    const bestRoute = profitA.gt(profitB) ? "A" : "B";
    const bestProfit = profitA.gt(profitB) ? profitA : profitB;
    const buyOnUniswap = bestRoute === "A";

    info("Route A (Uni→Sushi)", `${fmtEth(profitA)} ETH profit`);
    info("Route B (Sushi→Uni)", `${fmtEth(profitB)} ETH profit`);
    info("Best Route", `${bestRoute} — buyOnUniswap=${buyOnUniswap}`);

    // Step 5: Encode the bundle
    step(5, "Encoding executeArbitrage() for Flashbots bundle...");
    const iface = new ethers.utils.Interface(contractABI);
    const calldata = iface.encodeFunctionData("executeArbitrage", [
        ADDR.WETH, ADDR.USDC, arbAmount, buyOnUniswap, 3000, 0,
    ]);
    info("Function", "executeArbitrage()");
    info("Calldata", `${calldata.slice(0, 20)}...${calldata.slice(-8)} (${calldata.length / 2 - 1} bytes)`);
    info("Net profit", `${fmtEth(bestProfit)} ETH ($${(parseFloat(fmtEth(bestProfit)) * uniF).toFixed(2)})`);

    if (bestProfit.gt(0)) {
        success(`PROFITABLE ARB DETECTED! ${fmtEth(bestProfit)} ETH from 10 ETH trade`);
    } else {
        success(`Cross-DEX spread of ${spread}% detected (round-trip not profitable at 10 ETH)`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// DEMO 2 — LIQUIDATION: Real Aave V3 position + analysis
// ═══════════════════════════════════════════════════════════════════════
async function demoLiquidation() {
    section("DEMO 2 — AAVE LIQUIDATION");
    console.log("  Scenario: Our bot monitors Aave borrowers. When a position's");
    console.log("  Health Factor drops below 1.0, we liquidate it for profit.\n");

    // Step 1: Create an Aave position
    step(1, "Creating a test borrower on Aave V3...");

    const supplyAmount = parseEther("5.0");
    const weth = new ethers.Contract(ADDR.WETH, WETH_ABI, whale);
    await weth.deposit({ value: supplyAmount });
    await weth.approve(ADDR.AAVE_POOL, supplyAmount);

    const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, whale);
    await pool.supply(ADDR.WETH, supplyAmount, WHALE, 0);
    info("Supplied", `${fmtEth(supplyAmount)} WETH as collateral`);

    let accountData = await pool.getUserAccountData(WHALE);
    const maxBorrowUSD = parseFloat(formatUnits(accountData.availableBorrowsBase, 8));
    info("Max borrow", `$${maxBorrowUSD.toFixed(2)} USD`);

    // Borrow 95% of max
    const borrowBase = accountData.availableBorrowsBase.mul(95).div(100);
    const borrowUSDC = borrowBase.mul(1000000).div(100000000);

    await pool.borrow(ADDR.USDC, borrowUSDC, 2, 0, WHALE);
    info("Borrowed", `${fmtUsd(borrowUSDC)} USDC (95% of max)`);

    // Step 2: Check health factor
    step(2, "Querying position health...");
    accountData = await pool.getUserAccountData(WHALE);
    const collateralUSD = parseFloat(formatUnits(accountData.totalCollateralBase, 8));
    const debtUSD = parseFloat(formatUnits(accountData.totalDebtBase, 8));
    const hf = parseFloat(formatUnits(accountData.healthFactor, 18));

    info("Collateral", `$${collateralUSD.toFixed(2)}`);
    info("Debt", `$${debtUSD.toFixed(2)}`);
    info("Health Factor", `${hf.toFixed(4)} ${hf < 1.05 ? "⚠️  DANGER" : "✅"}`);
    info("LTV", `${((debtUSD / collateralUSD) * 100).toFixed(1)}%`);

    // Step 3: Profit calculation
    step(3, "Calculating liquidation profitability...");
    const liquidationBonus = 5;
    const maxRepay = debtUSD * 0.5;
    const collateralSeized = maxRepay * (1 + liquidationBonus / 100);
    const flashLoanFee = maxRepay * 0.0005;
    const gasCostUSD = 0.015 * collateralUSD / 5;
    const grossProfit = collateralSeized - maxRepay;
    const netProfit = grossProfit - flashLoanFee - gasCostUSD;

    info("Max repayable (50%)", `$${maxRepay.toFixed(2)} USDC`);
    info("Collateral seized", `$${collateralSeized.toFixed(2)} (incl. ${liquidationBonus}% bonus)`);
    info("Flash loan fee", `$${flashLoanFee.toFixed(2)}`);
    info("Est. gas cost", `~$${gasCostUSD.toFixed(2)}`);
    info("Gross profit", `$${grossProfit.toFixed(2)}`);
    info("Net profit", `$${netProfit.toFixed(2)}`);

    // Step 4: Encode
    step(4, "Encoding executeLiquidation() for Flashbots...");
    const iface = new ethers.utils.Interface(contractABI);
    const calldata = iface.encodeFunctionData("executeLiquidation", [
        ADDR.WETH, ADDR.USDC, WHALE, borrowUSDC.div(2), false, 0,
    ]);
    info("Function", "executeLiquidation()");
    info("Target", `${WHALE.slice(0, 10)}...`);
    info("Calldata", `${calldata.slice(0, 20)}...${calldata.slice(-8)} (${calldata.length / 2 - 1} bytes)`);

    success(`Position created at ${hf.toFixed(4)} HF — ready for liquidation when HF < 1.0`);
}

// ═══════════════════════════════════════════════════════════════════════
// DEMO 3 — BACKRUN: Detect and bundle behind a large mempool swap
// ═══════════════════════════════════════════════════════════════════════
async function demoBackrun() {
    section("DEMO 3 — MEMPOOL BACKRUNNING");
    console.log("  Scenario: A 50 ETH swap appears in the pending mempool.");
    console.log("  Our bot decodes it, builds a 2-tx Flashbots bundle to profit");
    console.log("  from the price impact.\n");

    const targetSwapAmount = parseEther("50.0");
    const fakeTargetTxHash = "0x" + "a1b2c3d4".repeat(8);

    step(1, "Large swap detected in pending mempool!");
    info("Tx Hash", `${fakeTargetTxHash.slice(0, 14)}...`);
    info("To", "0x3bFA...48E (Uniswap V3 SwapRouter02)");
    info("Value", `${fmtEth(targetSwapAmount)} ETH`);
    info("Function", "exactInputSingle()");

    step(2, "Decoding swap calldata...");
    info("tokenIn", `${ADDR.WETH.slice(0, 10)}... (WETH)`);
    info("tokenOut", `${ADDR.USDC.slice(0, 10)}... (USDC)`);
    info("amountIn", `${fmtEth(targetSwapAmount)} WETH`);
    info("fee", "3000 (0.3% pool)");

    step(3, "Estimating price impact from target swap...");
    const currentPrice = await getUniPrice(parseEther("1.0"), 3000);
    const currentPriceF = parseFloat(fmtUsd(currentPrice));
    const estimatedImpact = 0.4;
    const postPrice = currentPriceF * (1 - estimatedImpact / 100);
    info("Pre-impact price", `${currentPriceF.toFixed(2)} USDC/WETH`);
    info("Est. post-impact", `${postPrice.toFixed(2)} USDC/WETH`);
    info("Price impact", `~${estimatedImpact}%`);
    const backrunProfit = parseFloat(fmtEth(targetSwapAmount)) * estimatedImpact / 100;
    info("Est. backrun profit", `~${backrunProfit.toFixed(4)} ETH ($${(backrunProfit * currentPriceF).toFixed(2)})`);

    step(4, "Building 2-transaction Flashbots bundle...");
    console.log("    ┌─────────────────────────────────────────────┐");
    console.log("    │  Tx 1: Target's swap (signed raw bytes)     │");
    console.log("    │        50 ETH → USDC on Uniswap V3         │");
    console.log("    │        (creates price impact)               │");
    console.log("    ├─────────────────────────────────────────────┤");
    console.log("    │  Tx 2: Our backrun trade                    │");
    console.log("    │        executeBackrun() on AaveLiquidator   │");
    console.log("    │        (captures post-impact profit)        │");
    console.log("    └─────────────────────────────────────────────┘");

    step(5, "Encoding executeBackrun()...");
    const iface = new ethers.utils.Interface(contractABI);
    const calldata = iface.encodeFunctionData("executeBackrun", [
        ADDR.WETH, ADDR.USDC, targetSwapAmount, false, 3000, 0, fakeTargetTxHash,
    ]);
    info("Function", "executeBackrun()");
    info("targetTxHash", `${fakeTargetTxHash.slice(0, 14)}...`);
    info("Calldata", `${calldata.slice(0, 20)}...${calldata.slice(-8)} (${calldata.length / 2 - 1} bytes)`);
    info("Bundle type", "2-tx atomic (target + backrun)");

    success("Backrun bundle ready — both txs land in the same block");
}

// ═══════════════════════════════════════════════════════════════════════
// DEMO 4 — PROTECTION: Rescue a user from liquidation penalty
// ═══════════════════════════════════════════════════════════════════════
async function demoProtection() {
    section("DEMO 4 — USER PROTECTION (RESCUE)");
    console.log("  Scenario: A registered user's Health Factor is dropping toward");
    console.log("  1.0. Our bot preemptively repays 25% of their debt to save them");
    console.log("  from the 50% liquidation penalty.\n");

    const protectedUser = WHALE;

    step(1, "Monitoring protected user's position...");
    const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, provider);
    const data = await pool.getUserAccountData(protectedUser);
    const collateral = parseFloat(formatUnits(data.totalCollateralBase, 8));
    const debt = parseFloat(formatUnits(data.totalDebtBase, 8));
    const hf = parseFloat(formatUnits(data.healthFactor, 18));

    info("Protected user", `${protectedUser.slice(0, 10)}...`);
    info("Collateral", `$${collateral.toFixed(2)}`);
    info("Debt", `$${debt.toFixed(2)}`);
    info("Health Factor", `${hf.toFixed(4)}`);
    info("Protection threshold", "1.10");
    info("Status", hf < 1.1 ? "🚨 BELOW THRESHOLD — triggering rescue!" : `⚡ ${(hf - 1.1).toFixed(4)} above threshold`);

    step(2, "Calculating minimum repayment to save user...");
    const repayPercent = 25;
    const repayAmountUSD = debt * (repayPercent / 100);
    const repayUSDC = parseUnits(repayAmountUSD.toFixed(0), 6);
    const newDebt = debt - repayAmountUSD;
    const newHF = (collateral * 0.825) / newDebt;

    info("Repay amount (25%)", `$${repayAmountUSD.toFixed(2)} USDC`);
    info("New debt after repay", `$${newDebt.toFixed(2)}`);
    info("New Health Factor", `~${newHF.toFixed(4)} (safely above 1.0)`);
    info("Penalty avoided", `~$${(debt * 0.05).toFixed(2)} saved for user`);

    step(3, "Protection economics...");
    const flashLoanCost = repayAmountUSD * 0.0005;
    const gasCost = 0.015 * collateral / 5;
    info("Flash loan fee", `$${flashLoanCost.toFixed(2)} (0.05% of repay)`);
    info("Gas cost", `~$${gasCost.toFixed(2)}`);
    info("Total cost to bot", `$${(flashLoanCost + gasCost).toFixed(2)}`);
    info("Savings for user", `$${(debt * 0.05).toFixed(2)} (avoided 5% penalty)`);

    step(4, "Encoding executeProtection()...");
    const iface = new ethers.utils.Interface(contractABI);
    const calldata = iface.encodeFunctionData("executeProtection", [
        protectedUser, ADDR.USDC, repayUSDC,
    ]);
    info("Function", "executeProtection()");
    info("User rescued", `${protectedUser.slice(0, 10)}...`);
    info("Calldata", `${calldata.slice(0, 20)}...${calldata.slice(-8)} (${calldata.length / 2 - 1} bytes)`);

    success("Protection rescue ready — user saved from liquidation penalty!");
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════
async function main() {
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║                                                              ║");
    console.log("║   ⚡ ShieldTx — Live Strategy Demo                           ║");
    console.log("║   4-Strategy MEV Detection & Execution System                ║");
    console.log("║                                                              ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");

    try {
        provider = new ethers.providers.JsonRpcProvider(FORK_URL);
        const block = await provider.getBlockNumber();
        const network = await provider.getNetwork();
        console.log(`\n  Connected to Anvil mainnet fork`);
        console.log(`  Block: ${block}  |  Chain ID: ${network.chainId}`);
    } catch (err) {
        console.error("\n  ❌ Cannot connect to Anvil. Start it with:");
        console.error("     anvil --fork-url $MAINNET_RPC_URL --port 8545\n");
        process.exit(1);
    }

    // Fund our test account via Anvil cheatcode
    await provider.send("anvil_setBalance", [WHALE, ethers.utils.hexValue(parseEther("10000"))]);
    await provider.send("anvil_impersonateAccount", [WHALE]);
    whale = provider.getSigner(WHALE);

    await demoArbitrage();
    await demoLiquidation();
    await demoBackrun();
    await demoProtection();

    // Summary
    console.log("\n" + "═".repeat(62));
    console.log("  DEMO COMPLETE — All 4 strategies demonstrated");
    console.log("═".repeat(62));
    console.log("\n  Strategies shown:");
    console.log("    1. ✅ Arbitrage   — Real cross-DEX price manipulation + detection");
    console.log("    2. ✅ Liquidation — Real Aave V3 position + profitability analysis");
    console.log("    3. ✅ Backrun     — Mempool decode + 2-tx bundle construction");
    console.log("    4. ✅ Protection  — User rescue calculation + encoding");
    console.log("\n  Live dashboard:  http://localhost:3000");
    console.log("  Smart contract:  0x847335923C5D3d70791349E3b5d3Ed65739758c2 (Sepolia)\n");

    process.exit(0);
}

main().catch((err) => {
    console.error("\n  ❌ Demo failed:", err.message);
    console.error(err);
    process.exit(1);
});
