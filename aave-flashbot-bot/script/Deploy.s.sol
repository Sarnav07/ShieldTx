//SPDX-License-Identifier : MIT
pragma solidity ^0.8.20;

import {Script} from "../lib/forge-std/src/Script.sol";
import {console} from "../lib/forge-std/src/console.sol";
import {AaveLiquidator} from "../src/AaveLiquidator.sol";

contract Deploy is Script {
    // Mainnet
    address constant MAINNET_AAVE_POOL =
        0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant MAINNET_UNISWAP =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // Sepolia
    address constant SEPOLIA_AAVE_POOL =
        0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address constant SEPOLIA_UNISWAP =
        0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 chainId = block.chainid;

        address aavePool;
        address uniswapRouter;

        if (chainId == 1) {
            aavePool = MAINNET_AAVE_POOL;
            uniswapRouter = MAINNET_UNISWAP;
        } else if (chainId == 11155111) {
            aavePool = SEPOLIA_AAVE_POOL;
            uniswapRouter = SEPOLIA_UNISWAP;
        } else {
            revert("Unsupported chain");
        }

        vm.startBroadcast(deployerKey);
        AaveLiquidator aaveLiquidator = new AaveLiquidator(
            aavePool,
            uniswapRouter
        );
        vm.stopBroadcast();

        console.log(
            "We have deployed Aave Liquidator to ",
            address(aaveLiquidator)
        );
        console.log("Aave Pool: ", aavePool);
        console.log("Uniswap Router: ", uniswapRouter);
        console.log("Chain ID: ", chainId);
    }
}
