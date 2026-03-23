const { ethers } = require("ethers");

const IS_MAINNET = process.env.NETWORK === "mainnet";

const MAINNET = {
  AAVE_POOL_ADDRESS: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  AAVE_ORACLE_ADDRESS: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
  UNISWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
  TOKENS: {
    WETH: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
    USDC: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    DAI: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  }
};

const SEPOLIA = {
  AAVE_POOL_ADDRESS: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  AAVE_ORACLE_ADDRESS: "0x2da88497588bf726262c9F2A4A1Fe8278e499713",
  UNISWAP_ROUTER: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  UNISWAP_QUOTER: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
  TOKENS: {
    WETH: { address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", decimals: 18 },
    USDC: { address: "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8", decimals: 6 },
    DAI: { address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", decimals: 18 },
  }
};

const ACTIVE = IS_MAINNET ? MAINNET : SEPOLIA;

const AAVE_POOL_ADDRESS = ACTIVE.AAVE_POOL_ADDRESS;
const AAVE_ORACLE_ADDRESS = ACTIVE.AAVE_ORACLE_ADDRESS;
const UNISWAP_ROUTER = ACTIVE.UNISWAP_ROUTER;
const UNISWAP_QUOTER = ACTIVE.UNISWAP_QUOTER;
const TOKENS = ACTIVE.TOKENS;


const HF_LIQUIDATABLE = ethers.parseUnits("1.0", 18); // we will fire immediately
const HF_DANGER_ZONE = ethers.parseUnits("1.05", 18); // we will start watching closely
const MIN_PROFIT_ETH = ethers.parseEther("0.005");    // we should skip tiny opportunities
//MINPROFITETH IS FOR FOR DECIDING WHETHER TO SEND A BUNDLE OR NOT
const CLOSE_FACTOR = 50n; // Aave V3 allows 50% of debt per liquidation


const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)"
];

const AAVE_ORACLE_ABI = [
  "function getAssetPrice(address asset) view returns (uint256)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)"
];

module.exports = {
  AAVE_POOL_ADDRESS, AAVE_ORACLE_ADDRESS,
  UNISWAP_ROUTER, UNISWAP_QUOTER,
  TOKENS, HF_LIQUIDATABLE, HF_DANGER_ZONE,
  MIN_PROFIT_ETH, CLOSE_FACTOR,
  AAVE_POOL_ABI, AAVE_ORACLE_ABI, QUOTER_ABI, ERC20_ABI
};