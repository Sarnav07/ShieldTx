//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "../lib/forge-std/src/Test.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../src/interfaces/IAavePool.sol";

contract AaveLiquidatorTest is Test {
    AaveLiquidator public liquidator;

    // real mainnet addresses
    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    address constant UNDERWATER_USER =
        0x1000000000000000000000000000000000000000; // need to put a real address

    function setUp() public {
        // fork mainnet at known block
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"), 19500000);
        liquidator = new AaveLiquidator();
    }

    function test_OwnerIsDeployer() public view {
        assertEq(liquidator.owner(), address(this));
    }

    function test_onlyOwnerCanLiquidate() public {
        vm.prank(address(0xdEaD));
        vm.expectRevert("Not Owner");
        liquidator.executeLiquidation(
            WETH,
            USDC,
            address(0),
            1000000,
            false,
            0,
            3000
        );
    }

    function test_onlyAaveCanCallExecuteOperation() public {
        vm.prank(address(0xdEaD));
        vm.expectRevert(AaveLiquidator.AaveLiquidator__NotAavePool.selector);
        liquidator.executeOperation(USDC, 1e6, 500, address(this), "");
    }

    function test_flashLoanRoundTrip() public {
        deal(USDC, address(liquidator), 1000e6);

        vm.expectRevert();
        liquidator.executeLiquidation(
            WETH,
            USDC,
            address(0),
            100e6,
            false,
            0,
            3000
        );
    }

    function test_withdrawToken() public {
        deal(USDC, address(liquidator), 100e6);

        uint256 balBefore = IERC20(USDC).balanceOf(address(this));
        liquidator.withdraw(USDC);
        uint256 balAfter = IERC20(USDC).balanceOf(address(this));

        assertEq(balAfter - balBefore, 100e6, "Should withdraw full balance");
    }

    function test_withdrawTokenRevertsIfEmpty() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                AaveLiquidator
                    .AaveLiquidator__NotEnoughBalanceToWithdraw
                    .selector,
                0
            )
        );
        liquidator.withdraw(USDC);
    }

    function test_withdrawETH() public {
        vm.deal(address(liquidator), 1 ether);

        uint256 balBefore = address(this).balance;
        liquidator.withdrawETH();
        uint256 balAfter = address(this).balance;

        assertEq(
            balAfter - balBefore,
            1 ether,
            "Should withdraw full ETH balance"
        );
    }

    function test_withdrawETHRevertsIfEmpty() public {
        vm.expectRevert(
            AaveLiquidator.AaveLiquidator__NothingToWithdraw.selector
        );
        liquidator.withdrawETH();
    }

    // ===================== FULL LIQUIDATION (needs real underwater user) =====================

    // Uncomment when you find a real underwater user at block 19500000
    // function test_fullLiquidation() public {
    //     // 1. verify position is underwater
    //     (,,,,,uint256 hf) = IPool(AAVE_POOL).getUserAccountData(UNDERWATER_USER);
    //     assertLt(hf, 1e18, "User should be underwater");
    //
    //     // 2. record balances before
    //     uint256 usdcBefore = IERC20(USDC).balanceOf(address(liquidator));
    //
    //     // 3. execute with 0.3% Uniswap pool, 1 USDC minimum profit
    //     liquidator.executeLiquidation(WETH, USDC, UNDERWATER_USER, 500e6, false, 1e6, 3000);
    //
    //     // 4. verify profit
    //     uint256 profit = IERC20(USDC).balanceOf(address(liquidator)) - usdcBefore;
    //     assertGt(profit, 1e6, "Profit should exceed minimum");
    //     emit log_named_uint("Net profit USDC", profit);
    //     emit log_named_uint("Profit in dollars", profit / 1e6);
    // }

    receive() external payable {}
}
