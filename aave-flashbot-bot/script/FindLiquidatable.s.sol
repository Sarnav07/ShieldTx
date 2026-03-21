//SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "../lib/forge-std/src/Script.sol";
import {IPool} from "../src/interfaces/IAavePool.sol";

contract FindLiquidatable is Script {
    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    address[] candidates = [];

    function run() external view {
        IPool pool = IPool(AAVE_POOL);

        for (uint i = 0; i < candidates.length; i++) {
            (, , , , , uint256 hf) = pool.getUserAccountData(candidates[i]);
            if (hf < 1e18 && hf > 0) {
                console.log("Liquidatable", candidates[i]);
                console.log("Health Factor:", hf);
            }
        }
    }
}
