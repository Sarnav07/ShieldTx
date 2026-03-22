/**
 * profitCalculator.js
 *
 * Pure math module — decides whether a liquidation is worth executing.
 *
 * Input:  a liquidation signal from Person B's watcher
 * Output: { isWorthIt, grossProfitETH, netProfitETH, recommendedTip, gasCostETH }
 *
 * Dependencies: ethers.js (for BigNumber math + provider for gas/price queries)
 */

const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Configuration — Sepolia testnet
// ---------------------------------------------------------------------------

const IS_MAINNET = process.env.NETWORK === "mainnet";

let CONTRACT_ADDRESS;
if (IS_MAINNET) {
  try {
    const demoConfigPath = path.resolve(__dirname, "../../.demo-contract.json");
    const demoConfig = JSON.parse(fs.readFileSync(demoConfigPath, "utf-8"));
    CONTRACT_ADDRESS = demoConfig.contractAddress;
  } catch (e) {
    console.warn("⚠️  [WARN] No .demo-contract.json found. Run inject-chaos.js first!");
    CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000";
  }
} else {
  const NETWORKS_PATH = path.resolve(__dirname, "../../aave-flashbot-bot/config/networks.json");
  const NETWORKS = JSON.parse(fs.readFileSync(NETWORKS_PATH, "utf-8"));
  CONTRACT_ADDRESS = NETWORKS.sepolia.contractAddress;
}



// Token addresses
const WETH_ADDR = IS_MAINNET
  ? "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
  : "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

const USDC_ADDR = IS_MAINNET
  ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  : "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8";

const CONFIG = {
  // Aave V3 liquidation bonus — 5% on most assets (1.05 multiplier)
  LIQUIDATION_BONUS_BPS: 500, // basis points (500 = 5%)

  // Aave V3 close factor — can liquidate up to 50% of debt when HF < 1
  CLOSE_FACTOR: 0.5,

  // Estimated gas for the full flash loan→liquidation→swap→repay flow
  ESTIMATED_GAS_UNITS: 450_000,

  // What % of net profit to offer the block builder (0.75 = 75%)
  TIP_PERCENTAGE: 0.75,

  // Minimum profit in ETH below which we skip the liquidation
  MIN_PROFIT_THRESHOLD_ETH: 0.001,

  // Chainlink price feed addresses
  // NOTE: On an Anvil fork or testnet, we assume stablecoins = $1.00
  PRICE_FEEDS: {
    // ETH/USD (Sepolia and Mainnet use different feeds, but for the demo we'll use a fast mock)
    [WETH_ADDR]: IS_MAINNET ? "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" : "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },

  // Stablecoins that we assume = $1.00
  STABLECOINS: new Set([USDC_ADDR]),
};

// Minimal Chainlink aggregator ABI — just what we need
const AGGREGATOR_ABI = [
  "function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() external view returns (uint8)",
];

// ---------------------------------------------------------------------------
// Price fetching
// ---------------------------------------------------------------------------

/**
 * Fetches the USD price of a token from its Chainlink price feed.
 *
 * @param {string} tokenAddress - ERC-20 token address
 * @param {ethers.Provider} provider - JSON-RPC provider
 * @returns {Promise<number>} price in USD (human-readable decimal)
 */
async function getTokenPriceUSD(tokenAddress, provider) {
  // Stablecoins: assume $1.00 on testnet (no Chainlink feed on Sepolia)
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

  // Chainlink returns price as int256 with `decimals` decimal places
  return Number(answer) / 10 ** Number(decimals);
}

/**
 * Fetches the current base fee from the latest block.
 *
 * @param {ethers.Provider} provider
 * @returns {Promise<bigint>} base fee in wei
 */
async function getBaseFee(provider) {
  const block = await provider.getBlock("latest");
  return block.baseFeePerGas;
}

// ---------------------------------------------------------------------------
// Core profit calculation
// ---------------------------------------------------------------------------

/**
 * Calculates whether a liquidation is profitable and how much to tip.
 *
 * Signal shape (from Person B):
 * {
 *   borrower:         "0x...",
 *   debtAsset:        "0x...",
 *   collateralAsset:  "0x...",
 *   maxDebtToRepay:   "500000000",           // raw BigNumber string
 *   collateralAmount: "210000000000000000",   // estimated collateral to seize
 *   healthFactor:     "0.94"
 * }
 *
 * @param {object} signal - liquidation signal from Person B
 * @param {ethers.Provider} provider - JSON-RPC provider
 * @returns {Promise<object>} profit analysis result
 */
async function calculateProfit(signal, provider) {
  const {
    debtAsset,
    collateralAsset,
    maxDebtToRepay,
    collateralAmount,
  } = signal;

  // 1. Fetch prices in USD
  const [collateralPriceUSD, debtPriceUSD, ethPriceUSD] = await Promise.all([
    getTokenPriceUSD(collateralAsset, provider),
    getTokenPriceUSD(debtAsset, provider),
    getTokenPriceUSD(WETH_ADDR, provider),
  ]);

  // 2. Determine token decimal scaling
  //    USDC = 6 decimals, WETH = 18 decimals
  const debtDecimals = getTokenDecimals(debtAsset);
  const collateralDecimals = getTokenDecimals(collateralAsset);

  // Convert raw amounts to human-readable
  const debtAmountHuman =
    Number(BigInt(maxDebtToRepay)) / 10 ** debtDecimals;
  const collateralAmountHuman =
    Number(BigInt(collateralAmount)) / 10 ** collateralDecimals;

  // 3. Gross profit in USD
  //    collateral received includes the 5% bonus from Aave
  const collateralValueUSD = collateralAmountHuman * collateralPriceUSD;
  const debtValueUSD = debtAmountHuman * debtPriceUSD;

  // Flash loan premium is 0.05% (5 bps)
  const flashLoanPremiumUSD = debtValueUSD * 0.0005;

  // Uniswap swap fee (using the 0.3% tier)
  const swapFeeUSD = collateralValueUSD * 0.003;

  const grossProfitUSD =
    collateralValueUSD - debtValueUSD - flashLoanPremiumUSD - swapFeeUSD;

  // 4. Gas cost estimation
  const baseFee = await getBaseFee(provider);
  const priorityFee = ethers.parseUnits("2", "gwei"); // 2 gwei priority fee
  const totalGasPrice = baseFee + priorityFee;
  const gasCostWei =
    totalGasPrice * BigInt(CONFIG.ESTIMATED_GAS_UNITS);
  const gasCostETH = Number(gasCostWei) / 1e18;
  const gasCostUSD = gasCostETH * ethPriceUSD;

  // 5. Net profit
  const netProfitUSD = grossProfitUSD - gasCostUSD;
  const netProfitETH = netProfitUSD / ethPriceUSD;
  const grossProfitETH = grossProfitUSD / ethPriceUSD;

  // 6. Builder tip — 75% of net profit to stay competitive
  const recommendedTipETH = Math.max(netProfitETH * CONFIG.TIP_PERCENTAGE, 0);
  const keeperProfitETH = netProfitETH - recommendedTipETH;

  // 7. Decision
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Known token decimals. Extend this as you add more assets.
 * For a hackathon, hardcoding is fine. Production would query the contract.
 */
const TOKEN_DECIMALS = {
  [USDC_ADDR]: 6,
  [WETH_ADDR]: 18,
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

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  calculateProfit,
  getTokenPriceUSD,
  getBaseFee,
  CONFIG,
  CONTRACT_ADDRESS,
  WETH_ADDR,
  USDC_ADDR,
};
