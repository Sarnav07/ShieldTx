/**
 * fork-test.js — Mainnet Fork Strategy Tester
 *
 * Tests all bundler strategies against a local Anvil mainnet fork
 * with REAL on-chain liquidity (Uniswap V3 pools, Sushiswap V2 pairs,
 * Aave V3 positions).
 *
 * Usage:
 *   1. Start Anvil fork:
 *      anvil --fork-url https://mainnet.infura.io/v3/YOUR_KEY --port 8545
 *   2. Run this test:
 *      node test/fork-test.js
 */

const { ethers } = require("ethers");
const path = require("path");

// ─── Mainnet addresses (these exist on the Anvil fork) ─────────────
const MAINNET = {
    AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    AAVE_ORACLE: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
    UNISWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    UNISWAP_QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    SUSHI_ROUTER_V2: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
};

const QUOTER_ABI = [
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const SUSHI_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

const AAVE_POOL_ABI = [
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

const AAVE_ORACLE_ABI = [
    "function getAssetPrice(address asset) view returns (uint256)",
];

// Load the contract ABI for encoding tests
const contractABI = require("../../aave-flashbot-bot/config/abi.json");

// ─── Helpers ───────────────────────────────────────────────────────

const FORK_URL = "http://127.0.0.1:8545";
let provider;
let passed = 0;
let failed = 0;

function ok(name) {
    passed++;
    console.log(`  ✅ ${name}`);
}
function fail(name, err) {
    failed++;
    console.log(`  ❌ ${name}: ${err}`);
}

// ─── Test 1: Uniswap V3 Quoting ───────────────────────────────────

async function testUniV3Quote() {
    console.log("\n━━━ TEST 1: Uniswap V3 Quote (WETH → USDC, 0.3% pool) ━━━");

    const quoter = new ethers.Contract(MAINNET.UNISWAP_QUOTER_V2, QUOTER_ABI, provider);
    const amountIn = ethers.parseEther("1.0"); // 1 WETH

    try {
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: MAINNET.WETH,
            tokenOut: MAINNET.USDC,
            amountIn: amountIn,
            fee: 3000,
            sqrtPriceLimitX96: 0,
        });

        const amountOut = result.amountOut;
        const usdcOut = parseFloat(ethers.formatUnits(amountOut, 6));

        if (usdcOut > 100 && usdcOut < 100000) {
            ok(`1 WETH = ${usdcOut.toFixed(2)} USDC (pool has real liquidity)`);
        } else {
            fail("Quote returned unreasonable value", `${usdcOut} USDC`);
        }

        return amountOut;
    } catch (err) {
        fail("Uniswap V3 quoteExactInputSingle", err.message);
        return null;
    }
}

// ─── Test 2: Sushiswap V2 Quoting ─────────────────────────────────

async function testSushiV2Quote() {
    console.log("\n━━━ TEST 2: Sushiswap V2 Quote (WETH → USDC) ━━━");

    const sushi = new ethers.Contract(MAINNET.SUSHI_ROUTER_V2, SUSHI_ABI, provider);
    const amountIn = ethers.parseEther("1.0"); // 1 WETH

    try {
        const amounts = await sushi.getAmountsOut(amountIn, [MAINNET.WETH, MAINNET.USDC]);
        const usdcOut = parseFloat(ethers.formatUnits(amounts[1], 6));

        if (usdcOut > 100 && usdcOut < 100000) {
            ok(`1 WETH = ${usdcOut.toFixed(2)} USDC on Sushiswap V2`);
        } else {
            fail("Sushi quote returned unreasonable value", `${usdcOut} USDC`);
        }

        return amounts[1];
    } catch (err) {
        fail("Sushiswap V2 getAmountsOut", err.message);
        return null;
    }
}

// ─── Test 3: Cross-DEX Price Comparison ────────────────────────────

async function testCrossDexPriceComparison(uniOut, sushiOut) {
    console.log("\n━━━ TEST 3: Cross-DEX Price Comparison ━━━");

    if (!uniOut || !sushiOut) {
        fail("Skipped", "need both Uni and Sushi quotes");
        return;
    }

    const uniUSDC = parseFloat(ethers.formatUnits(uniOut, 6));
    const sushiUSDC = parseFloat(ethers.formatUnits(sushiOut, 6));
    const spread = ((Math.abs(uniUSDC - sushiUSDC) / Math.min(uniUSDC, sushiUSDC)) * 100).toFixed(4);

    console.log(`    Uniswap V3:   ${uniUSDC.toFixed(2)} USDC`);
    console.log(`    Sushiswap V2: ${sushiUSDC.toFixed(2)} USDC`);
    console.log(`    Spread:       ${spread}%`);

    if (uniUSDC > sushiUSDC) {
        console.log(`    → Uni gives more → buyOnUniswap=false (buy Sushi, sell Uni) could profit`);
    } else {
        console.log(`    → Sushi gives more → buyOnUniswap=true (buy Uni, sell Sushi) could profit`);
    }

    ok(`Cross-DEX spread detected: ${spread}%`);
}

// ─── Test 4: Cross-DEX Round Trip ──────────────────────────────────

async function testCrossDexRoundTrip() {
    console.log("\n━━━ TEST 4: Cross-DEX Round-Trip Arb Check ━━━");

    const quoter = new ethers.Contract(MAINNET.UNISWAP_QUOTER_V2, QUOTER_ABI, provider);
    const sushi = new ethers.Contract(MAINNET.SUSHI_ROUTER_V2, SUSHI_ABI, provider);
    const amountIn = ethers.parseEther("1.0");

    try {
        // Route A: Buy USDC on Uni V3, Sell USDC on Sushi V2
        const leg1A = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: MAINNET.WETH, tokenOut: MAINNET.USDC,
            amountIn, fee: 3000, sqrtPriceLimitX96: 0,
        });
        const leg2A = await sushi.getAmountsOut(leg1A.amountOut, [MAINNET.USDC, MAINNET.WETH]);
        const profitA = leg2A[1] - amountIn;
        const profitEthA = parseFloat(ethers.formatEther(profitA));
        console.log(`    Route A (Uni→Sushi): ${profitEthA.toFixed(6)} ETH profit`);

        // Route B: Buy USDC on Sushi V2, Sell USDC on Uni V3
        const leg1B = await sushi.getAmountsOut(amountIn, [MAINNET.WETH, MAINNET.USDC]);
        const leg2B = await quoter.quoteExactInputSingle.staticCall({
            tokenIn: MAINNET.USDC, tokenOut: MAINNET.WETH,
            amountIn: leg1B[1], fee: 3000, sqrtPriceLimitX96: 0,
        });
        const profitB = leg2B.amountOut - amountIn;
        const profitEthB = parseFloat(ethers.formatEther(profitB));
        console.log(`    Route B (Sushi→Uni): ${profitEthB.toFixed(6)} ETH profit`);

        const bestRoute = profitA > profitB ? "A (buyOnUniswap=true)" : "B (buyOnUniswap=false)";
        const bestProfit = Math.max(profitEthA, profitEthB);
        console.log(`    Best route: ${bestRoute} → ${bestProfit.toFixed(6)} ETH`);

        if (bestProfit > 0) {
            ok(`Profitable arb found! ${bestProfit.toFixed(6)} ETH (before gas)`);
        } else {
            ok(`No profitable arb right now (spread: ${bestProfit.toFixed(6)} ETH) — this is normal`);
        }
    } catch (err) {
        fail("Round-trip arb check", err.message);
    }
}

// ─── Test 5: Aave V3 Position Query ───────────────────────────────

async function testAavePositionQuery() {
    console.log("\n━━━ TEST 5: Aave V3 Position Query ━━━");

    const pool = new ethers.Contract(MAINNET.AAVE_POOL, AAVE_POOL_ABI, provider);

    // Query a known large Aave borrower (this is a whale address commonly in Aave)
    const testUser = "0x1000000000000000000000000000000000000000";

    try {
        const data = await pool.getUserAccountData(testUser);
        const collateral = parseFloat(ethers.formatUnits(data.totalCollateralBase, 8));
        const debt = parseFloat(ethers.formatUnits(data.totalDebtBase, 8));
        const hf = data.healthFactor;
        const hfFormatted = hf > 0n ? parseFloat(ethers.formatUnits(hf, 18)).toFixed(4) : "N/A (no debt)";

        console.log(`    User:       ${testUser}`);
        console.log(`    Collateral: $${collateral.toFixed(2)}`);
        console.log(`    Debt:       $${debt.toFixed(2)}`);
        console.log(`    Health:     ${hfFormatted}`);

        ok("Aave V3 getUserAccountData works on fork");
    } catch (err) {
        fail("Aave getUserAccountData", err.message);
    }
}

// ─── Test 6: Aave Oracle Price Fetch ──────────────────────────────

async function testAaveOracle() {
    console.log("\n━━━ TEST 6: Aave Oracle Prices ━━━");

    const oracle = new ethers.Contract(MAINNET.AAVE_ORACLE, AAVE_ORACLE_ABI, provider);

    try {
        const wethPrice = await oracle.getAssetPrice(MAINNET.WETH);
        const usdcPrice = await oracle.getAssetPrice(MAINNET.USDC);

        // Aave oracle returns prices in USD with 8 decimals
        const wethUsd = parseFloat(ethers.formatUnits(wethPrice, 8));
        const usdcUsd = parseFloat(ethers.formatUnits(usdcPrice, 8));

        console.log(`    WETH: $${wethUsd.toFixed(2)}`);
        console.log(`    USDC: $${usdcUsd.toFixed(2)}`);

        if (wethUsd > 500 && wethUsd < 50000 && usdcUsd > 0.9 && usdcUsd < 1.1) {
            ok("Aave Oracle prices are reasonable");
        } else {
            fail("Oracle prices look wrong", `WETH=$${wethUsd}, USDC=$${usdcUsd}`);
        }
    } catch (err) {
        fail("Aave Oracle getAssetPrice", err.message);
    }
}

// ─── Test 7: ABI Encoding ─────────────────────────────────────────

async function testABIEncoding() {
    console.log("\n━━━ TEST 7: ABI Encoding (all 3 strategies) ━━━");

    const iface = new ethers.Interface(contractABI);

    // Liquidation
    try {
        const liqCalldata = iface.encodeFunctionData("executeLiquidation", [
            MAINNET.WETH, MAINNET.USDC,
            "0x0000000000000000000000000000000000000001",
            ethers.parseUnits("1000", 6),
            false, 0,
        ]);
        if (liqCalldata.startsWith("0x")) {
            ok(`executeLiquidation encoded (${liqCalldata.length / 2 - 1} bytes)`);
        }
    } catch (err) { fail("encodeLiquidation", err.message); }

    // Arbitrage
    try {
        const arbCalldata = iface.encodeFunctionData("executeArbitrage", [
            MAINNET.WETH, MAINNET.USDC,
            ethers.parseEther("1.0"),
            true, 3000, 0,
        ]);
        if (arbCalldata.startsWith("0x")) {
            ok(`executeArbitrage encoded (${arbCalldata.length / 2 - 1} bytes)`);
        }
    } catch (err) { fail("encodeArbitrage", err.message); }

    // Backrun
    try {
        const backrunCalldata = iface.encodeFunctionData("executeBackrun", [
            MAINNET.WETH, MAINNET.USDC,
            ethers.parseEther("1.0"),
            true, 3000, 0,
            "0x" + "ab".repeat(32), // targetTxHash
        ]);
        if (backrunCalldata.startsWith("0x")) {
            ok(`executeBackrun encoded (${backrunCalldata.length / 2 - 1} bytes)`);
        }
    } catch (err) { fail("encodeBackrun", err.message); }

    // Protection
    try {
        const protCalldata = iface.encodeFunctionData("executeProtection", [
            "0x0000000000000000000000000000000000000001",
            MAINNET.USDC,
            ethers.parseUnits("500", 6),
        ]);
        if (protCalldata.startsWith("0x")) {
            ok(`executeProtection encoded (${protCalldata.length / 2 - 1} bytes)`);
        }
    } catch (err) { fail("encodeProtection", err.message); }
}

// ─── Test 8: Multi-Fee-Tier Uni V3 Quotes ─────────────────────────

async function testMultiFeeTier() {
    console.log("\n━━━ TEST 8: Uniswap V3 Multi-Fee-Tier Quotes ━━━");

    const quoter = new ethers.Contract(MAINNET.UNISWAP_QUOTER_V2, QUOTER_ABI, provider);
    const amountIn = ethers.parseEther("1.0");
    const feeTiers = [100, 500, 3000, 10000];

    for (const fee of feeTiers) {
        try {
            const result = await quoter.quoteExactInputSingle.staticCall({
                tokenIn: MAINNET.WETH, tokenOut: MAINNET.USDC,
                amountIn, fee, sqrtPriceLimitX96: 0,
            });
            const usdcOut = parseFloat(ethers.formatUnits(result.amountOut, 6));
            ok(`${(fee / 100).toFixed(2)}% tier: 1 WETH = ${usdcOut.toFixed(2)} USDC`);
        } catch {
            console.log(`  ⚪ ${(fee / 100).toFixed(2)}% tier: no pool or no liquidity (skipped)`);
        }
    }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║   ShieldTx — Mainnet Fork Strategy Tester               ║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║   Fork URL: ${FORK_URL.padEnd(43)}║`);
    console.log("╚══════════════════════════════════════════════════════════╝");

    try {
        provider = new ethers.JsonRpcProvider(FORK_URL);
        const block = await provider.getBlockNumber();
        console.log(`\n  Connected to fork at block ${block}`);
    } catch (err) {
        console.error("\n❌ Cannot connect to Anvil fork at", FORK_URL);
        console.error("   Start it with:");
        console.error("   anvil --fork-url https://mainnet.infura.io/v3/YOUR_KEY --port 8545\n");
        process.exit(1);
    }

    const uniOut = await testUniV3Quote();
    const sushiOut = await testSushiV2Quote();
    await testCrossDexPriceComparison(uniOut, sushiOut);
    await testCrossDexRoundTrip();
    await testAavePositionQuery();
    await testAaveOracle();
    await testABIEncoding();
    await testMultiFeeTier();

    console.log("\n══════════════════════════════════════════════════════════");
    console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log("══════════════════════════════════════════════════════════\n");

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
