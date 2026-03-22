//SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Simulator — Pre-flight check for liquidation profitability
/// @notice Person B/C run this before sending a Flashbots bundle

import {Script, console} from "../lib/forge-std/src/Script.sol";
import {IPool} from "../src/interfaces/IAavePool.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";

contract Simulator is Script {
    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    function run() external view {
        address user = vm.envAddress("TARGET_USER");
        address collateral = vm.envAddress("COLLATERAL_ASSET");
        address debt = vm.envAddress("DEBT_ASSET");
        uint256 amount = vm.envUint("DEBT_AMOUNT");

        IPool pool = IPool(AAVE_POOL);

        // 1. Check health factor
        (, , , , , uint256 hf) = pool.getUserAccountData(user);
        console.log("=== ShieldTx Liquidation Simulator ===");
        console.log("User:", user);
        console.log("Health Factor:", hf);
        console.log("Liquidatable:", hf < 1e18 && hf > 0);

        if (hf >= 1e18) {
            console.log("RESULT: User is healthy, no liquidation possible");
            return;
        }

        // 2. Estimate profitability
        uint256 flashLoanFee = (amount * 5) / 10000;
        uint256 liquidationBonus = 10500; // ~5% for most assets
        uint256 collateralReceived = (amount * liquidationBonus) / 10000;

        if (collateralReceived > amount + flashLoanFee) {
            uint256 profit = collateralReceived - (amount + flashLoanFee);
            console.log("");
            console.log("Flash Loan Fee:", flashLoanFee);
            console.log("Expected Collateral:", collateralReceived);
            console.log("Estimated Profit:", profit);
            console.log("RESULT: PROFITABLE - send bundle!");
        } else {
            console.log("RESULT: NOT PROFITABLE - skip");
        }
    }
}

// To run:
// TARGET_USER=0x123... \
// COLLATERAL_ASSET=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
// DEBT_ASSET=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
// DEBT_AMOUNT=500000000 \
// forge script script/Simulator.s.sol --fork-url $ALCHEMY_RPC_URL
