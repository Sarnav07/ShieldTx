//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISwapRouter {
    struct ExactOutputSimpleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceX96After;
    }

    function exactOutputSimple(
        ExactOutputSimpleParams calldata params
    ) external payable returns (uint256 amountIn);
}
