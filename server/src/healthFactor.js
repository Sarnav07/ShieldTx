const { ethers } = require("ethers");
const { HF_LIQUIDATABLE, HF_DANGER_ZONE, CLOSE_FACTOR } = require("./constants");

function parseAccountData(rawData) {
    return {
        totalCollateralUsd: rawData.totalCollateralBase,
        totalDebtUsd: rawData.totalDebtBase,
        healthFactor: rawData.healthFactor,
        isLiquidatable: rawData.healthFactor < HF_LIQUIDATABLE,
        isDangerZone: rawData.healthFactor < HF_DANGER_ZONE,
    };
}
function getMaxDebtToRepay(totalDebtUsd) {
    return (totalDebtUsd * CLOSE_FACTOR) / 100n;
}

function formatHF(healthFactor) {
    return parseFloat(ethers.formatUnits(healthFactor, 18)).toFixed(4);
}

module.exports = {
    parseAccountData, getMaxDebtToRepay,
    formatHF
};