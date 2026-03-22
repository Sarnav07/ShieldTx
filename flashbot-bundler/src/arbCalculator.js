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
const { getBaseFee, SEPOLIA_WETH, SEPOLIA_USDC } = require("./profitCalculator");

// ---------------------------------------------------------------------------
// Sepolia DEX Addresses
// ---------------------------------------------------------------------------

const SEPOLIA_ADDRESSES = {
    // Uniswap V3 Routers — our contract can use either as dexA / dexB
    SWAP_ROUTER_02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    UNIVERSAL_ROUTER: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",

    // QuoterV2 — used to simulate swap output amounts (view function, no gas cost)
    QUOTER_V2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",

    // Uniswap V3 Factory — used to check if pools exist
    FACTORY: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
};

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
        SEPOLIA_ADDRESSES.QUOTER_V2,
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
        SEPOLIA_ADDRESSES.FACTORY,
        FACTORY_ABI,
        provider
    );

    const poolAddress = await factory.getPool(tokenA, tokenB, feeTier);
    return poolAddress !== ethers.ZeroAddress;
}

/**
 * Scans all fee tier combinations for arbitrage opportunities.
 *
 * Strategy: Buy tokenOut on the cheaper pool (lower output = higher price),
 * sell on the more expensive pool (higher output = lower price).
 * Actually: if Pool A gives more tokenOut per tokenIn than Pool B,
 * we buy on Pool A and sell back on Pool B — but since we're doing
 * a round trip (tokenIn → tokenOut → tokenIn), we check if we end
 * up with more tokenIn than we started.
 *
 * @param {ethers.Provider} provider
 * @param {string} tokenIn - e.g., WETH
 * @param {string} tokenOut - e.g., USDC
 * @returns {Promise<object|null>} The best arb opportunity, or null
 */
async function findArbOpportunity(provider, tokenIn, tokenOut) {
    const feeTiers = Object.values(FEE_TIERS);

    // Step 1: Get quotes for every fee tier
    const quotes = {};
    const quotePromises = feeTiers.map(async (fee) => {
        // Use the smallest probe amount for price discovery
        const quote = await getQuote(
            provider,
            tokenIn,
            tokenOut,
            ARB_CONFIG.PROBE_AMOUNTS_WETH[0],
            fee
        );
        if (quote) {
            quotes[fee] = quote;
        }
    });

    await Promise.all(quotePromises);

    const activeTiers = Object.keys(quotes).map(Number);
    if (activeTiers.length < 2) {
        return null; // Need at least 2 pools to arb between
    }

    // Step 2: For each pair of fee tiers, check the round-trip profit
    let bestOpportunity = null;

    for (let i = 0; i < activeTiers.length; i++) {
        for (let j = 0; j < activeTiers.length; j++) {
            if (i === j) continue;

            const buyFee = activeTiers[i];
            const sellFee = activeTiers[j];

            // Try each probe amount to find the best one
            for (const amountIn of ARB_CONFIG.PROBE_AMOUNTS_WETH) {
                const opportunity = await checkRoundTrip(
                    provider,
                    tokenIn,
                    tokenOut,
                    amountIn,
                    buyFee,
                    sellFee
                );

                if (opportunity && opportunity.profitRaw > 0n) {
                    if (!bestOpportunity || opportunity.profitRaw > bestOpportunity.profitRaw) {
                        bestOpportunity = opportunity;
                    }
                }
            }
        }
    }

    return bestOpportunity;
}

/**
 * Checks the round-trip profitability:
 *   tokenIn --[buyFee]--> tokenOut --[sellFee]--> tokenIn
 *
 * If we get back more tokenIn than we started, it's a profitable arb.
 *
 * @returns {Promise<object|null>}
 */
async function checkRoundTrip(
    provider,
    tokenIn,
    tokenOut,
    amountIn,
    buyFee,
    sellFee
) {
    // Leg 1: tokenIn → tokenOut on buyFee pool
    const leg1 = await getQuote(provider, tokenIn, tokenOut, amountIn, buyFee);
    if (!leg1) return null;

    // Leg 2: tokenOut → tokenIn on sellFee pool
    const leg2 = await getQuote(provider, tokenOut, tokenIn, leg1.amountOut, sellFee);
    if (!leg2) return null;

    const amountBack = leg2.amountOut;
    const profitRaw = amountBack - amountIn; // in tokenIn's smallest unit

    if (profitRaw <= 0n) return null;

    return {
        tokenIn,
        tokenOut,
        amountIn,
        amountBack,
        profitRaw,
        buyFee,
        sellFee,
        leg1AmountOut: leg1.amountOut,
        // For the contract: dexA = router to buy on, dexB = router to sell on
        // Since both are Uniswap V3 pools (just different fee tiers),
        // we use the same router — the contract's _swapOnDex hardcodes fee=3000,
        // so for proper cross-fee-tier arb, the contract would need updating.
        // For hackathon: we use SwapRouter02 for both legs.
        dexA: SEPOLIA_ADDRESSES.SWAP_ROUTER_02,
        dexB: SEPOLIA_ADDRESSES.SWAP_ROUTER_02,
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
        buyFee: opportunity.buyFee,
        sellFee: opportunity.sellFee,
        amountIn: opportunity.amountIn.toString(),
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
        buyOnUniswap: true, // Assuming the buy leg is on Uniswap for this placeholder logic
        uniswapFee: opportunity.buyFee,
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
    poolExists,
    SEPOLIA_ADDRESSES,
    FEE_TIERS,
    ARB_CONFIG,
};
