const { ethers } = require("ethers");
const { getBaseFee, SEPOLIA_WETH, SEPOLIA_USDC } = require("./profitCalculator");

const SEPOLIA_ADDRESSES = {
    SWAP_ROUTER_02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    UNIVERSAL_ROUTER: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",

    QUOTER_V2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    FACTORY: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
};

const FEE_TIERS = {
    LOWEST: 100,
    LOW: 500,
    MEDIUM: 3000,
    HIGH: 10000,
};

const QUOTER_ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const ARB_CONFIG = {
    MIN_PROFIT_ETH: 0.0005,

    TIP_PERCENTAGE: 0.75,

    ESTIMATED_GAS_UNITS: 350_000,

    PROBE_AMOUNTS_WETH: [
        ethers.parseEther("0.01"),  // 0.01 WETH
        ethers.parseEther("0.05"),  // 0.05 WETH
        ethers.parseEther("0.1"),   // 0.1 WETH
    ],
};


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
        return null;
    }
}

async function poolExists(provider, tokenA, tokenB, feeTier) {
    const factory = new ethers.Contract(
        SEPOLIA_ADDRESSES.FACTORY,
        FACTORY_ABI,
        provider
    );

    const poolAddress = await factory.getPool(tokenA, tokenB, feeTier);
    return poolAddress !== ethers.ZeroAddress;
}


async function findArbOpportunity(provider, tokenIn, tokenOut) {
    const feeTiers = Object.values(FEE_TIERS);

    const quotes = {};
    const quotePromises = feeTiers.map(async (fee) => {
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
        return null;
    }

    let bestOpportunity = null;

    for (let i = 0; i < activeTiers.length; i++) {
        for (let j = 0; j < activeTiers.length; j++) {
            if (i === j) continue;

            const buyFee = activeTiers[i];
            const sellFee = activeTiers[j];

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


async function checkRoundTrip(
    provider,
    tokenIn,
    tokenOut,
    amountIn,
    buyFee,
    sellFee
) {
    const leg1 = await getQuote(provider, tokenIn, tokenOut, amountIn, buyFee);
    if (!leg1) return null;

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
        dexA: SEPOLIA_ADDRESSES.SWAP_ROUTER_02,
        dexB: SEPOLIA_ADDRESSES.SWAP_ROUTER_02,
    };
}

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


function toArbSignal(opportunity) {
    return {
        type: "arbitrage",
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        amountIn: opportunity.amountIn.toString(),
        dexA: opportunity.dexA,
        dexB: opportunity.dexB,
        buyFee: opportunity.buyFee,
        sellFee: opportunity.sellFee,
        expectedProfitRaw: opportunity.profitRaw.toString(),
    };
}

function round(n, places = 6) {
    return Math.round(n * 10 ** places) / 10 ** places;
}


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
