const { ethers } = require("ethers");
const { getBaseFee } = require("./profitCalculator");

const IS_MAINNET = process.env.NETWORK === "mainnet";

const MAINNET = {
    SWAP_ROUTER_02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    UNIVERSAL_ROUTER: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
};

const SEPOLIA = {
    SWAP_ROUTER_02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    UNIVERSAL_ROUTER: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
    QUOTER_V2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    FACTORY: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
};

const ACTIVE = IS_MAINNET ? MAINNET : SEPOLIA;

const SUSHI_ROUTER_V2 = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const SUSHI_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
];

const QUOTER_ABI = [
    "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
];

const FEE_TIERS = { LOWEST: 100, LOW: 500, MEDIUM: 3000, HIGH: 10000 };

const ARB_CONFIG = {
    MIN_PROFIT_ETH: 0.0005,
    TIP_PERCENTAGE: 0.75,
    ESTIMATED_GAS_UNITS: 350_000,
    PROBE_AMOUNTS_WETH: [
        ethers.parseEther("0.01"),
        ethers.parseEther("0.05"),
        ethers.parseEther("0.1"),
    ],
};

async function getQuote(provider, tokenIn, tokenOut, amountIn, fee) {
    const quoter = new ethers.Contract(ACTIVE.QUOTER_V2, QUOTER_ABI, provider);
    try {
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0,
        });
        return { amountOut: result.amountOut, gasEstimate: result.gasEstimate };
    } catch {
        return null;
    }
}

async function getSushiQuote(provider, tokenIn, tokenOut, amountIn) {
    const router = new ethers.Contract(SUSHI_ROUTER_V2, SUSHI_ABI, provider);
    try {
        const amounts = await router.getAmountsOut(amountIn, [tokenIn, tokenOut]);
        return { amountOut: amounts[1] };
    } catch {
        return null;
    }
}

async function poolExists(provider, tokenA, tokenB, fee) {
    const factory = new ethers.Contract(ACTIVE.FACTORY, FACTORY_ABI, provider);
    const addr = await factory.getPool(tokenA, tokenB, fee);
    return addr !== ethers.ZeroAddress;
}

async function checkCrossDexRoundTrip(provider, tokenIn, tokenOut, amountIn, uniswapFee, buyOnUniswap) {
    let leg1Out, leg2Out;

    if (buyOnUniswap) {
        const leg1 = await getQuote(provider, tokenIn, tokenOut, amountIn, uniswapFee);
        if (!leg1) return null;
        leg1Out = leg1.amountOut;

        const leg2 = await getSushiQuote(provider, tokenOut, tokenIn, leg1Out);
        if (!leg2) return null;
        leg2Out = leg2.amountOut;
    } else {
        const leg1 = await getSushiQuote(provider, tokenIn, tokenOut, amountIn);
        if (!leg1) return null;
        leg1Out = leg1.amountOut;

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
        buyOnUniswap,
        uniswapFee,
        leg1AmountOut: leg1Out,
        dexA: buyOnUniswap ? ACTIVE.SWAP_ROUTER_02 : SUSHI_ROUTER_V2,
        dexB: buyOnUniswap ? SUSHI_ROUTER_V2 : ACTIVE.SWAP_ROUTER_02,
    };
}

async function findArbOpportunity(provider, tokenIn, tokenOut) {
    const fees = Object.values(FEE_TIERS);
    let best = null;

    for (const amountIn of ARB_CONFIG.PROBE_AMOUNTS_WETH) {
        for (const fee of fees) {
            for (const direction of [true, false]) {
                const opp = await checkCrossDexRoundTrip(provider, tokenIn, tokenOut, amountIn, fee, direction);
                if (opp && opp.profitRaw > 0n && (!best || opp.profitRaw > best.profitRaw)) {
                    best = opp;
                }
            }
        }
    }

    return best;
}

async function calculateArbProfit(opportunity, provider) {
    const baseFee = await getBaseFee(provider);
    const priorityFee = ethers.parseUnits("2", "gwei");
    const gasCostWei = (baseFee + priorityFee) * BigInt(ARB_CONFIG.ESTIMATED_GAS_UNITS);

    const profitETH = Number(opportunity.profitRaw) / 1e18;
    const gasCostETH = Number(gasCostWei) / 1e18;
    const netProfitETH = profitETH - gasCostETH;

    const tipETH = Math.max(netProfitETH * ARB_CONFIG.TIP_PERCENTAGE, 0);
    const keeperETH = netProfitETH - tipETH;

    return {
        isWorthIt: netProfitETH >= ARB_CONFIG.MIN_PROFIT_ETH,
        grossProfitETH: round(profitETH),
        netProfitETH: round(netProfitETH),
        gasCostETH: round(gasCostETH),
        recommendedTipETH: round(tipETH),
        keeperProfitETH: round(keeperETH),
        amountIn: opportunity.amountIn?.toString(),
    };
}

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