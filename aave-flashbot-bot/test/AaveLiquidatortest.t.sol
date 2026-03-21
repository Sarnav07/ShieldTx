//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "../lib/forge-std/src/Test.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

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
        liquidator.executeLiquidation(WETH, USDC, address(0), 1000000, false);
    }

    function test_onlyAaveCanCallExecueteOperation() public {
        vm.prank(address(0xdEaD));
        vm.expectRevert(AaveLiquidator.AaveLiquidator__NotAavePool.selector);
        liquidator.executeOperation(USDC, 1e6, 500, address(this), "");
    }

    function test_flashLoanRoundTrip() public {
        deal(USDC, address(liquidator), 1000e6);

        vm.expectRevert();
        liquidator.executeLiquidation(WETH, USDC, address(0), 100e6, false);
    }

    // replacing underwater user with real address

    // function test_fullLiquidation() public {
    //     liquidator.executeLiquidation(
    //         WETH,
    //         USDC,
    //         UNDERWATER_USER,
    //         500e6,
    //         false
    //     );
    //     uint256 profit = IERC20(USDC).balanceOf(address(liquidator));
    //     assertGt(profit, 0, "have profit after liquidation");
    //     emit log("profit", profit);
    // }
}
