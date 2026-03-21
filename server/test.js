const { parseAccountData, getMaxDebtToRepay, formatHF } = require("./src/healthFactor");

// Mock data
const rawData = {
  totalCollateralBase: 100000000n, // 1000 USD (1e8)
  totalDebtBase: 50000000n,        // 500 USD
  healthFactor: 950000000000000000n // 0.95
};

console.log("Parsed:", parseAccountData(rawData));

console.log("Max repay:", getMaxDebtToRepay(50000000n));

console.log("HF:", formatHF(950000000000000000n));
