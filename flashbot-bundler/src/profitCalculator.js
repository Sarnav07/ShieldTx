const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const IS_MAINNET = process.env.NETWORK === "mainnet";

let CONTRACT_ADDRESS;
if (IS_MAINNET) {
  try {
    const p = path.resolve(__dirname, "../../.demo-contract.json");
    CONTRACT_ADDRESS = JSON.parse(fs.readFileSync(p, "utf-8")).contractAddress;
  } catch {
    console.warn("no .demo-contract.json — run inject-chaos.js first");
    CONTRACT_ADDRESS = ethers.ZeroAddress;
  }
} else {
  const networks = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "../../aave-flashbot-bot/config/networks.json"),
    "utf-8"
  ));
  CONTRACT_ADDRESS = networks.sepolia.contractAddress;
}

const WETH_ADDR = IS_MAINNET
  ? "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
  : "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

const USDC_ADDR = IS_MAINNET
  ? "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  : "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8";

const CONFIG = {
  LIQUIDATION_BONUS_BPS: 500,
  CLOSE_FACTOR: 0.5,
  ESTIMATED_GAS_UNITS: 450_000,
  TIP_PERCENTAGE: 0.75,
  MIN_PROFIT_THRESHOLD_ETH: 0.001,
  PRICE_FEEDS: {
    [WETH_ADDR]: IS_MAINNET
      ? "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419"
      : "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },
  STABLECOINS: new Set([USDC_ADDR]),
};

const AGGREGATOR_ABI = [
  "function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() external view returns (uint8)",
];

const TOKEN_DECIMALS = {
  [USDC_ADDR]: 6,
  [WETH_ADDR]: 18,
};

function getTokenDecimals(addr) {
  const d = TOKEN_DECIMALS[addr];
  if (d === undefined) {
    console.warn(`unknown decimals for ${addr}, assuming 18`);
    return 18;
  }
  return d;
}

async function getTokenPriceUSD(tokenAddress, provider) {
  if (CONFIG.STABLECOINS.has(tokenAddress)) return 1.0;

  const feed = CONFIG.PRICE_FEEDS[tokenAddress];
  if (!feed) throw new Error(`no price feed for ${tokenAddress}`);

  const contract = new ethers.Contract(feed, AGGREGATOR_ABI, provider);
  const [, answer] = await contract.latestRoundData();
  const decimals = await contract.decimals();

  return Number(answer) / 10 ** Number(decimals);
}

async function getBaseFee(provider) {
  const block = await provider.getBlock("latest");
  return block.baseFeePerGas;
}

async function calculateProfit(signal, provider) {
  const { collateralAsset, debtAsset, maxDebtToRepay, collateralAmount } = signal;

  const [collateralPrice, debtPrice, ethPrice] = await Promise.all([
    getTokenPriceUSD(collateralAsset, provider),
    getTokenPriceUSD(debtAsset, provider),
    getTokenPriceUSD(WETH_ADDR, provider),
  ]);

  const debtHuman = Number(BigInt(maxDebtToRepay)) / 10 ** getTokenDecimals(debtAsset);
  const collateralHuman = Number(BigInt(collateralAmount)) / 10 ** getTokenDecimals(collateralAsset);

  const collateralUSD = collateralHuman * collateralPrice;
  const debtUSD = debtHuman * debtPrice;
  const flashLoanFeeUSD = debtUSD * 0.0005;
  const swapFeeUSD = collateralUSD * 0.003;
  const grossProfitUSD = collateralUSD - debtUSD - flashLoanFeeUSD - swapFeeUSD;

  const baseFee = await getBaseFee(provider);
  const priorityFee = ethers.parseUnits("2", "gwei");
  const gasCostWei = (baseFee + priorityFee) * BigInt(CONFIG.ESTIMATED_GAS_UNITS);
  const gasCostETH = Number(gasCostWei) / 1e18;
  const gasCostUSD = gasCostETH * ethPrice;

  const netProfitUSD = grossProfitUSD - gasCostUSD;
  const netProfitETH = netProfitUSD / ethPrice;
  const grossProfitETH = grossProfitUSD / ethPrice;

  const tipETH = Math.max(netProfitETH * CONFIG.TIP_PERCENTAGE, 0);
  const keeperETH = netProfitETH - tipETH;

  return {
    isWorthIt: netProfitETH >= CONFIG.MIN_PROFIT_THRESHOLD_ETH,
    grossProfitUSD: round(grossProfitUSD),
    netProfitUSD: round(netProfitUSD),
    grossProfitETH: round(grossProfitETH),
    netProfitETH: round(netProfitETH),
    gasCostETH: round(gasCostETH),
    gasCostUSD: round(gasCostUSD),
    recommendedTipETH: round(tipETH),
    keeperProfitETH: round(keeperETH),
    prices: { collateralUSD: collateralPrice, debtUSD: debtPrice, ethUSD: ethPrice },
  };
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
  WETH_ADDR,
  USDC_ADDR,
};