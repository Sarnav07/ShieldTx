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

function pickBestDebt(userReserves) {
    const debts = userReserves.filter(r =>
        r.currentVariableDebt > 0n || r.currentStableDebt > 0n
    );
    if (debts.length === 0) return null;

    debts.sort((a, b) => {
        const debtA = (a.currentVariableDebt + a.currentStableDebt) * a.priceUsd;
        const debtB = (b.currentVariableDebt + b.currentStableDebt) * b.priceUsd;
        return debtB > debtA ? 1 : -1;
    });

    return {
        asset: debts[0].asset,
        totalDebt: debts[0].currentVariableDebt + debts[0].currentStableDebt,
    };
}

function pickBestCollateral(userReserves) {
    const collaterals = userReserves.filter(r =>
        r.usageAsCollateralEnabled && r.currentATokenBalance > 0n
    );
    if (collaterals.length === 0) return null;

    collaterals.sort((a, b) => {
        const valA = a.currentATokenBalance * a.priceUsd;
        const valB = b.currentATokenBalance * b.priceUsd;
        return valB > valA ? 1 : -1;
    });

    return collaterals[0].asset;
}




module.exports = {
    parseAccountData, getMaxDebtToRepay,
    formatHF, getStatus, pickBestDebt, pickBestCollateral
};