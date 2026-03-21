const { ethers } = require("ethers");
const { HF_LIQUIDATABLE, HF_DANGER_ZONE, CLOSE_FACTOR, TOKENS } = require("./constants");

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
function getStatus(healthFactor) {
    if (healthFactor < HF_LIQUIDATABLE) return "LIQUIDATABLE";
    if (healthFactor < HF_DANGER_ZONE) return "DANGER";
    return "SAFE";
}


module.exports = {
    parseAccountData, getMaxDebtToRepay,
    formatHF, getStatus,
};