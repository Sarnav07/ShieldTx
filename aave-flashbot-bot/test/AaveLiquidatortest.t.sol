//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "../lib/forge-std/src/Test.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";

contract AaveLiquidatorTest is Test {
    AaveLiquidator public liquidator;

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
            address(0),
            address(0),
            address(0),
            0,
            false
        );
    }
}
