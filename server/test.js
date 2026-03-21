const { parseAccountData, getMaxDebtToRepay, formatHF, getStatus, pickBestCollateral, pickBestDebt } = require("./src/healthFactor");

// Mock data
const rawData = {
  totalCollateralBase: 100000000n, // 1000 USD (1e8)
  totalDebtBase: 50000000n,        // 500 USD
  healthFactor: 950000000000000000n // 0.95
};

console.log("Parsed:", parseAccountData(rawData));

console.log("Max repay:", getMaxDebtToRepay(50000000n));

console.log("HF:", formatHF(950000000000000000n));

console.log("Status:", getStatus(950000000000000000n));

const userReserves = [
  {
    asset: "WETH",
    currentATokenBalance: 2n,
    usageAsCollateralEnabled: true,
    priceUsd: 2000n,
    currentVariableDebt: 0n,
    currentStableDebt: 0n
  },
  {
    asset: "USDC",
    currentATokenBalance: 0n,
    usageAsCollateralEnabled: false,
    priceUsd: 1n,
    currentVariableDebt: 1000n,
    currentStableDebt: 0n
  }
];

console.log("Best collateral:", pickBestCollateral(userReserves));
console.log("Best debt:", pickBestDebt(userReserves));
