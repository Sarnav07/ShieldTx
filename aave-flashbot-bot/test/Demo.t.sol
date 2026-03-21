//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "../lib/forge-std/src/Test.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../src/interfaces/IAavePool.sol";

contract DemoTest is Test {
    // Mainnet addresses
    address constant MAINNET_AAVE_POOL =
        0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant MAINNET_UNISWAP =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // Replace with a real underwater user at block 19500000
    address constant UNDERWATER_USER =
        0x1000000000000000000000000000000000000000;

    function test_showMeTheMoney() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"), 19500000);

        AaveLiquidator liquidator = new AaveLiquidator(
            MAINNET_AAVE_POOL,
            MAINNET_UNISWAP
        );

        // Verify user is actually underwater
        (, , , , , uint256 hf) = IPool(MAINNET_AAVE_POOL).getUserAccountData(
            UNDERWATER_USER
        );
        console.log("Health Factor:", hf);
        assertLt(hf, 1e18, "User must be underwater");

        uint256 before = IERC20(USDC).balanceOf(address(liquidator));

        liquidator.executeLiquidation(
            WETH,
            USDC,
            UNDERWATER_USER,
            500e6,
            false,
            1e6, // min 1 USDC profit
            3000 // 0.3% Uniswap pool
        );

        uint256 profit = IERC20(USDC).balanceOf(address(liquidator)) - before;

        console.log("Flash loan: 500 USDC borrowed");
        console.log("Position liquidated successfully");
        console.log("Profit earned (raw):", profit);
        console.log("Profit earned ($):", profit / 1e6);

        assertGt(profit, 0);
    }

    function test_simulateLiquidation() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"), 19500000);

        AaveLiquidator liquidator = new AaveLiquidator(
            MAINNET_AAVE_POOL,
            MAINNET_UNISWAP
        );

        (
            uint256 expectedProfit,
            uint256 flashLoanFee,
            bool isProfitable
        ) = liquidator.simulateLiquidation(WETH, USDC, UNDERWATER_USER, 500e6);

        console.log("Expected profit:", expectedProfit);
        console.log("Flash loan fee:", flashLoanFee);
        console.log("Is profitable:", isProfitable);

        assertTrue(isProfitable, "Should be estimated as profitable");
    }
}
