//SPDX-License-Identifier : MIT
pragma solidity ^0.8.20;

import {Script} from "../lib/forge-std/src/Script.sol";
import {console} from "../lib/forge-std/src/console.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        AaveLiquidator aaveLiquidator = new AaveLiquidator();
        vm.stopBroadcast();

        console.log(
            "We have deployed Aave Liquidator to ",
            address(aaveLiquidator)
        );
    }
}
