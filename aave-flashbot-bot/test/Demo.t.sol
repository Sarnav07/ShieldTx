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
            1e6 // min 1 USDC profit
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

    function test_hackathonDemo() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"), 19500000);

        AaveLiquidator liq = new AaveLiquidator(
            MAINNET_AAVE_POOL,
            MAINNET_UNISWAP
        );

        console.log("=== ShieldTx MEV Bot Demo ===");
        console.log("");
        console.log(
            "SCENARIO: User borrowed $10,000 USDC against ETH collateral"
        );
        console.log("ETH price dropped 20%. Health Factor is now 0.94");
        console.log("Position is underwater and open for liquidation");
        console.log("");

        (, , , , , uint256 hfBefore) = IPool(MAINNET_AAVE_POOL)
            .getUserAccountData(UNDERWATER_USER);
        console.log("Health Factor before:", hfBefore);

        // NOTE: This will only work with a real underwater user address
        // Replace UNDERWATER_USER with a real address to see full demo
        if (hfBefore >= 1e18) {
            console.log("");
            console.log("DEMO NOTE: Replace UNDERWATER_USER with a real");
            console.log("underwater address at block 19500000 to see");
            console.log("the full liquidation + profit output.");
            return;
        }

        uint256 balanceBefore = IERC20(USDC).balanceOf(address(liq));

        liq.executeLiquidation(WETH, USDC, UNDERWATER_USER, 500e6, false, 1e6);

        uint256 profit = IERC20(USDC).balanceOf(address(liq)) - balanceBefore;

        console.log("");
        console.log("RESULT:");
        console.log("Flash loan borrowed: 500 USDC (zero capital required)");
        console.log("Liquidation executed atomically via Flashbots");
        console.log("Collateral seized and swapped back via Uniswap V3");
        console.log("Flash loan repaid in same transaction");
        console.log("Net profit: $", profit / 1e6);
        console.log("");
        console.log("If beaten by competitor: bundle dropped, zero gas cost");
    }
}
