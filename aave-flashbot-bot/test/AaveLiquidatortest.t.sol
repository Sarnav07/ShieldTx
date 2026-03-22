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
        0x1000000000000000000000000000000000000000;

    function setUp() public {
        vm.createSelectFork(vm.envString("ALCHEMY_RPC_URL"), 19500000);
        liquidator = new AaveLiquidator(
            0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2, // mainnet Aave
            0xE592427A0AEce92De3Edee1F18E0157C05861564 // mainnet Uniswap
        );
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
            0
        );
    }

    function test_onlyAaveCanCallExecuteOperation() public {
        vm.prank(address(0xdEaD));
        vm.expectRevert(AaveLiquidator.AaveLiquidator__NotAavePool.selector);
        liquidator.executeOperation(USDC, 1e6, 500, address(this), "");
    }

    function test_arbitrageAccessControl() public {
        vm.prank(address(0xdead));
        vm.expectRevert("Not Owner");
        liquidator.executeArbitrage(USDC, WETH, 1000e6, true, 3000, 1e6);
    }

    function test_backrunAccessControl() public {
        vm.prank(address(0xdead));
        vm.expectRevert("Not Owner");
        liquidator.executeBackrun(
            USDC,
            WETH,
            1000e6,
            true,
            3000,
            1e6,
            bytes32(0)
        );
    }

    function test_protectionAccessControl() public {
        vm.prank(address(0xdead));
        vm.expectRevert("Not Owner");
        liquidator.executeProtection(address(0x123), USDC, 100e6);
    }

    function test_flashLoanRoundTrip() public {
        deal(USDC, address(liquidator), 1000e6);

        vm.expectRevert();
        liquidator.executeLiquidation(WETH, USDC, address(0), 100e6, false, 0);
    }

    function test_protectionRegistration() public {
        liquidator.registerProtection(address(0x123), 1.2e18);
        assertTrue(liquidator.protectedUsers(address(0x123)));
        assertEq(liquidator.protectionThreshold(address(0x123)), 1.2e18);
    }

    function test_unregisteredProtectionReverts() public {
        vm.expectRevert("User not registered");
        liquidator.executeProtection(address(0xdead), USDC, 100e6);
    }

    function test_fundContract() public {
        deal(USDC, address(this), 1000e6);
        IERC20(USDC).approve(address(liquidator), 1000e6);
        liquidator.fund(USDC, 1000e6);

        assertEq(
            IERC20(USDC).balanceOf(address(liquidator)),
            1000e6,
            "Contract should hold funded amount"
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

    function test_simulateLiquidation() public view {
        (
            uint256 expectedProfit,
            uint256 flashLoanFee,
            bool isProfitable
        ) = liquidator.simulateLiquidation(WETH, USDC, UNDERWATER_USER, 500e6);

        assertTrue(isProfitable, "Should estimate as profitable");
        assertGt(expectedProfit, 0, "Expected profit should be > 0");
        assertEq(flashLoanFee, 25e4, "Fee should be 0.05% of 500e6");
    }

    receive() external payable {}
}
