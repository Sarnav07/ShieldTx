const { ethers } = require("ethers");
const CONTRACT_ADDRESS = "0x847335923C5D3d70791349E3b5d3Ed65739758c2";


const SEPOLIA_WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const SEPOLIA_USDC = "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8";

const CONFIG = {
  LIQUIDATION_BONUS_BPS: 500, // basis points (500 = 5%)
  CLOSE_FACTOR: 0.5,
  ESTIMATED_GAS_UNITS: 450_000,
  TIP_PERCENTAGE: 0.75,
  MIN_PROFIT_THRESHOLD_ETH: 0.001,
  PRICE_FEEDS: {
    [SEPOLIA_WETH]: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },
  STABLECOINS: new Set([SEPOLIA_USDC]),
};

const AGGREGATOR_ABI = [
  "function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() external view returns (uint8)",
];

async function getTokenPriceUSD(tokenAddress, provider) {
  if (CONFIG.STABLECOINS.has(tokenAddress)) {
    return 1.0;
  }

  const feedAddress = CONFIG.PRICE_FEEDS[tokenAddress];
  if (!feedAddress) {
    throw new Error(`No price feed configured for token ${tokenAddress}`);
  }

  const feed = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);
  const [, answer, , ,] = await feed.latestRoundData();
  const decimals = await feed.decimals();

  return Number(answer) / 10 ** Number(decimals);
}

async function getBaseFee(provider) {
  const block = await provider.getBlock("latest");
  return block.baseFeePerGas;
}
async function calculateProfit(signal, provider) {
  const {
    debtAsset,
    collateralAsset,
    maxDebtToRepay,
    collateralAmount,
  } = signal;


  const [collateralPriceUSD, debtPriceUSD, ethPriceUSD] = await Promise.all([
    getTokenPriceUSD(collateralAsset, provider),
    getTokenPriceUSD(debtAsset, provider),
    getTokenPriceUSD(SEPOLIA_WETH, provider),
  ]);

  const debtDecimals = getTokenDecimals(debtAsset);
  const collateralDecimals = getTokenDecimals(collateralAsset);

  const debtAmountHuman =
    Number(BigInt(maxDebtToRepay)) / 10 ** debtDecimals;
  const collateralAmountHuman =
    Number(BigInt(collateralAmount)) / 10 ** collateralDecimals;

  const collateralValueUSD = collateralAmountHuman * collateralPriceUSD;
  const debtValueUSD = debtAmountHuman * debtPriceUSD;
  const flashLoanPremiumUSD = debtValueUSD * 0.0005;

  const swapFeeUSD = collateralValueUSD * 0.003;

  const grossProfitUSD =
    collateralValueUSD - debtValueUSD - flashLoanPremiumUSD - swapFeeUSD;
  const baseFee = await getBaseFee(provider);
  const priorityFee = ethers.parseUnits("2", "gwei");
  const totalGasPrice = baseFee + priorityFee;
  const gasCostWei =
    totalGasPrice * BigInt(CONFIG.ESTIMATED_GAS_UNITS);
  const gasCostETH = Number(gasCostWei) / 1e18;
  const gasCostUSD = gasCostETH * ethPriceUSD;

  const netProfitUSD = grossProfitUSD - gasCostUSD;
  const netProfitETH = netProfitUSD / ethPriceUSD;
  const grossProfitETH = grossProfitUSD / ethPriceUSD;

  const recommendedTipETH = Math.max(netProfitETH * CONFIG.TIP_PERCENTAGE, 0);
  const keeperProfitETH = netProfitETH - recommendedTipETH;

  const isWorthIt = netProfitETH >= CONFIG.MIN_PROFIT_THRESHOLD_ETH;

  return {
    isWorthIt,
    grossProfitUSD: round(grossProfitUSD),
    netProfitUSD: round(netProfitUSD),
    grossProfitETH: round(grossProfitETH),
    netProfitETH: round(netProfitETH),
    gasCostETH: round(gasCostETH),
    gasCostUSD: round(gasCostUSD),
    recommendedTipETH: round(recommendedTipETH),
    keeperProfitETH: round(keeperProfitETH),
    // Raw data for logging
    prices: {
      collateralUSD: collateralPriceUSD,
      debtUSD: debtPriceUSD,
      ethUSD: ethPriceUSD,
    },
  };
}

const TOKEN_DECIMALS = {
  [SEPOLIA_USDC]: 6,
  [SEPOLIA_WETH]: 18,
};

function getTokenDecimals(tokenAddress) {
  const decimals = TOKEN_DECIMALS[tokenAddress];
  if (decimals === undefined) {
    console.warn(
      `Unknown decimals for ${tokenAddress}, defaulting to 18`
    );
    return 18;
  }
  return decimals;
}

function round(n, places = 6) {
  return Math.round(n * 10 ** places) / 10 ** places;
}

module.exports = {
  calculateProfit,
  getTokenPriceUSD,
  getBaseFee,
  CONFIG,
  CONTRACT_ADDRESS,
  SEPOLIA_WETH,
  SEPOLIA_USDC,
};
