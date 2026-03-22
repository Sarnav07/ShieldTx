/**
 * arbCalculator.js
 *
 * DEX Arbitrage profit calculator — finds price differences between
 * Uniswap V3 pools (different fee tiers or different routers) and
 * determines if a flash-loan-funded arb is profitable.
 *
 * Flow:
 *   1. Query QuoterV2 for price on Pool A (e.g., 0.05% fee tier)
 *   2. Query QuoterV2 for price on Pool B (e.g., 0.3% fee tier)
 *   3. Calculate spread, subtract gas, size the builder tip
 *   4. Return { isWorthIt, signal } ready for the bundler
 */

const { ethers } = require("ethers");
const { getBaseFee, WETH_ADDR, USDC_ADDR } = require("./profitCalculator");

// ---------------------------------------------------------------------------
// Sepolia DEX Addresses
// ---------------------------------------------------------------------------

const IS_MAINNET = process.env.NETWORK === "mainnet";

const MAINNET_ADDRESSES = {
    SWAP_ROUTER_02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    UNIVERSAL_ROUTER: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
};

const SEPOLIA_ADDRESSES = {
    // Uniswap V3 Routers — our contract can use either as dexA / dexB
    SWAP_ROUTER_02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    UNIVERSAL_ROUTER: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",

    // QuoterV2 — used to simulate swap output amounts (view function, no gas cost)
    QUOTER_V2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",

    // Uniswap V3 Factory — used to check if pools exist
    FACTORY: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
};

const ACTIVE = IS_MAINNET ? MAINNET_ADDRESSES : SEPOLIA_ADDRESSES;

// Sushiswap V2 Router — must match the address hardcoded in AaveLiquidator.sol
// The contract uses this for the V2 leg of cross-DEX arbs.
const SUSHI_ROUTER_V2 = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const SUSHI_ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

// Uniswap V3 fee tiers in basis points
const FEE_TIERS = {
    LOWEST: 100,   // 0.01%
    LOW: 500,      // 0.05%
    MEDIUM: 3000,  // 0.3%
    HIGH: 10000,   // 1.0%
};

// QuoterV2 ABI — only the functions we need
const QUOTER_ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// Factory ABI — check if a pool exists
const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ARB_CONFIG = {
    // Minimum profit in ETH to execute the arb
    MIN_PROFIT_ETH: 0.0005,

    // Percentage of profit to tip the builder
    TIP_PERCENTAGE: 0.75,

    // Estimated gas for flash loan + 2 swaps + repay
    ESTIMATED_GAS_UNITS: 350_000,

    // Default trade sizes to probe (in token's smallest unit)
    // These are WETH amounts — start small on testnet
    PROBE_AMOUNTS_WETH: [
        ethers.parseEther("0.01"),  // 0.01 WETH
        ethers.parseEther("0.05"),  // 0.05 WETH
        ethers.parseEther("0.1"),   // 0.1 WETH
    ],
};

// ---------------------------------------------------------------------------
// Core: Find arb opportunities across fee tiers
// ---------------------------------------------------------------------------

/**
 * Queries the QuoterV2 to get the output amount for a swap.
 * This is a static call — costs no gas on-chain.
 *
 * @param {ethers.Provider} provider
 * @param {string} tokenIn
 * @param {string} tokenOut
 * @param {bigint} amountIn
 * @param {number} feeTier
 * @returns {Promise<{amountOut: bigint, gasEstimate: bigint} | null>}
 */
async function getQuote(provider, tokenIn, tokenOut, amountIn, feeTier) {
    const quoter = new ethers.Contract(
        ACTIVE.QUOTER_V2,
        QUOTER_ABI,
        provider
    );

    try {
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn,
            tokenOut,
            amountIn,
            fee: feeTier,
            sqrtPriceLimitX96: 0,
        });

        return {
            amountOut: result.amountOut,
            gasEstimate: result.gasEstimate,
        };
    } catch {
        // Pool doesn't exist for this fee tier, or no liquidity
        return null;
    }
}

/**
 * Checks if a Uniswap V3 pool exists for a token pair at a given fee tier.
 *
 * @param {ethers.Provider} provider
 * @param {string} tokenA
 * @param {string} tokenB
 * @param {number} feeTier
 * @returns {Promise<boolean>}
 */
async function poolExists(provider, tokenA, tokenB, feeTier) {
    const factory = new ethers.Contract(
        ACTIVE.FACTORY,
        FACTORY_ABI,
        provider
    );

    const poolAddress = await factory.getPool(tokenA, tokenB, feeTier);
    return poolAddress !== ethers.ZeroAddress;
}

/**
 * Queries Sushiswap V2 router for the output of a swap.
 * Uses getAmountsOut (view function, no gas cost).
 *
 * @param {ethers.Provider} provider
 * @param {string} tokenIn
 * @param {string} tokenOut
 * @param {bigint} amountIn
 * @returns {Promise<{amountOut: bigint} | null>}
 */
async function getSushiQuote(provider, tokenIn, tokenOut, amountIn) {
    const sushiRouter = new ethers.Contract(
        SUSHI_ROUTER_V2,
        SUSHI_ROUTER_ABI,
        provider
    );

    try {
        const amounts = await sushiRouter.getAmountsOut(amountIn, [tokenIn, tokenOut]);
        return { amountOut: amounts[1] };
    } catch {
        // Pair doesn't exist or no liquidity
        return null;
    }
}

/**
 * Scans for cross-DEX arbitrage opportunities between Uniswap V3 and Sushiswap V2.
 *
 * This matches the AaveLiquidator contract exactly:
 *   Route A (buyOnUniswap = true):  Buy on Uni V3 → Sell on Sushi V2
 *   Route B (buyOnUniswap = false): Buy on Sushi V2 → Sell on Uni V3
 *
 * For Route A, we try every Uni V3 fee tier as the buy leg.
 * For Route B, we try every Uni V3 fee tier as the sell leg.
 * The most profitable combination across all routes and probe amounts wins.
 *
 * @param {ethers.Provider} provider
 * @param {string} tokenIn - e.g., WETH
 * @param {string} tokenOut - e.g., USDC
 * @returns {Promise<object|null>} The best arb opportunity, or null
 */
async function findArbOpportunity(provider, tokenIn, tokenOut) {
    const feeTiers = Object.values(FEE_TIERS);
    let bestOpportunity = null;

    for (const amountIn of ARB_CONFIG.PROBE_AMOUNTS_WETH) {
        // ── Route A: Buy on Uniswap V3, Sell on Sushiswap V2 ──────────
        for (const fee of feeTiers) {
            const opp = await checkCrossDexRoundTrip(
                provider, tokenIn, tokenOut, amountIn, fee, true
            );
            if (opp && opp.profitRaw > 0n) {
                if (!bestOpportunity || opp.profitRaw > bestOpportunity.profitRaw) {
                    bestOpportunity = opp;
                }
            }
        }

        // ── Route B: Buy on Sushiswap V2, Sell on Uniswap V3 ──────────
        for (const fee of feeTiers) {
            const opp = await checkCrossDexRoundTrip(
                provider, tokenIn, tokenOut, amountIn, fee, false
            );
            if (opp && opp.profitRaw > 0n) {
                if (!bestOpportunity || opp.profitRaw > bestOpportunity.profitRaw) {
                    bestOpportunity = opp;
                }
            }
        }
    }

    return bestOpportunity;
}

/**
 * Checks the cross-DEX round-trip profitability.
 *
 * If buyOnUniswap = true:
 *   Leg 1: tokenIn →[Uni V3, uniswapFee]→ tokenOut
 *   Leg 2: tokenOut →[Sushi V2]→ tokenIn
 *
 * If buyOnUniswap = false:
 *   Leg 1: tokenIn →[Sushi V2]→ tokenOut
 *   Leg 2: tokenOut →[Uni V3, uniswapFee]→ tokenIn
 *
 * @returns {Promise<object|null>}
 */
async function checkCrossDexRoundTrip(
    provider, tokenIn, tokenOut, amountIn, uniswapFee, buyOnUniswap
) {
    let leg1Out, leg2Out;

    if (buyOnUniswap) {
        // Leg 1: Buy tokenOut on Uniswap V3
        const leg1 = await getQuote(provider, tokenIn, tokenOut, amountIn, uniswapFee);
        if (!leg1) return null;
        leg1Out = leg1.amountOut;

        // Leg 2: Sell tokenOut for tokenIn on Sushiswap V2
        const leg2 = await getSushiQuote(provider, tokenOut, tokenIn, leg1Out);
        if (!leg2) return null;
        leg2Out = leg2.amountOut;
    } else {
        // Leg 1: Buy tokenOut on Sushiswap V2
        const leg1 = await getSushiQuote(provider, tokenIn, tokenOut, amountIn);
        if (!leg1) return null;
        leg1Out = leg1.amountOut;

        // Leg 2: Sell tokenOut for tokenIn on Uniswap V3
        const leg2 = await getQuote(provider, tokenOut, tokenIn, leg1Out, uniswapFee);
        if (!leg2) return null;
        leg2Out = leg2.amountOut;
    }

    const profitRaw = leg2Out - amountIn;
    if (profitRaw <= 0n) return null;

    return {
        tokenIn,
        tokenOut,
        amountIn,
        amountBack: leg2Out,
        profitRaw,
        buyOnUniswap,      // maps directly to contract's buyOnUniswap param
        uniswapFee,        // maps directly to contract's uniswapFee param
        leg1AmountOut: leg1Out,
        dexA: buyOnUniswap ? ACTIVE.SWAP_ROUTER_02 : SUSHI_ROUTER_V2,
        dexB: buyOnUniswap ? SUSHI_ROUTER_V2 : ACTIVE.SWAP_ROUTER_02,
    };
}

// ---------------------------------------------------------------------------
// Profit analysis (mirrors profitCalculator.js output shape)
// ---------------------------------------------------------------------------

/**
 * Given an arb opportunity, calculates gas-adjusted profit and tip.
 *
 * @param {object} opportunity - from findArbOpportunity()
 * @param {ethers.Provider} provider
 * @returns {Promise<object>} profit analysis
 */
async function calculateArbProfit(opportunity, provider) {
    const baseFee = await getBaseFee(provider);
    const priorityFee = ethers.parseUnits("2", "gwei");
    const totalGasPrice = baseFee + priorityFee;
    const gasCostWei = totalGasPrice * BigInt(ARB_CONFIG.ESTIMATED_GAS_UNITS);

    const profitWei = opportunity.profitRaw;
    const profitETH = Number(profitWei) / 1e18;
    const gasCostETH = Number(gasCostWei) / 1e18;
    const netProfitETH = profitETH - gasCostETH;

    const recommendedTipETH = Math.max(netProfitETH * ARB_CONFIG.TIP_PERCENTAGE, 0);
    const keeperProfitETH = netProfitETH - recommendedTipETH;

    const isWorthIt = netProfitETH >= ARB_CONFIG.MIN_PROFIT_ETH;

    return {
        isWorthIt,
        grossProfitETH: round(profitETH),
        netProfitETH: round(netProfitETH),
        gasCostETH: round(gasCostETH),
        recommendedTipETH: round(recommendedTipETH),
        keeperProfitETH: round(keeperProfitETH),
        amountIn: opportunity.amountIn?.toString(),
    };
}

/**
 * Converts an arb opportunity into the signal shape the bundler expects.
 *
 * @param {object} opportunity
 * @returns {object} arbitrage signal
 */
function toArbSignal(opportunity) {
    return {
        type: "arbitrage",
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        amountIn: opportunity.amountIn.toString(),
        buyOnUniswap: opportunity.buyOnUniswap,
        uniswapFee: opportunity.uniswapFee,
        expectedProfitRaw: opportunity.profitRaw.toString(),
    };
}

function round(n, places = 6) {
    return Math.round(n * 10 ** places) / 10 ** places;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    findArbOpportunity,
    calculateArbProfit,
    toArbSignal,
    getQuote,
    getSushiQuote,
    poolExists,
    ACTIVE_ADDRESSES: ACTIVE,
    SUSHI_ROUTER_V2,
    FEE_TIERS,
    ARB_CONFIG,
};
