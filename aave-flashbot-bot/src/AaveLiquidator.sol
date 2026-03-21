//SPDX-License-Identifier : MIT
pragma solidity ^0.8.20;

import {IPool} from "./interfaces/IAavePool.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolAddressesProvider} from "./interfaces/IPoolAddressesProvider.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";

contract AaveLiquidator is IFlashLoanSimpleReceiver {
    // IMMUTABLES

    address public immutable AAVE_POOL;
    address public immutable UNISWAP_ROUTER;

    // ERRORS

    error AaveLiquidator__NotAavePool();
    error AaveLiquidator__NotProfitable(uint256 profit, uint256 minProfit);
    error AaveLiquidator__NotEnoughBalanceToWithdraw(uint256 bal);
    error AaveLiquidator__NothingToWithdraw();

    // STATE

    address public owner;
    IPool public aavePool;

    // EVENTS

    event LiquidationExecuted(
        address indexed user,
        address debtAsset,
        address collateralAsset,
        uint256 profit
    );

    event ArbitrageExecuted(address tokenIn, address tokenOut, uint256 profit);

    // STRUCT

    struct LiquidationParams {
        address collateralAsset;
        address debtAsset;
        address user;
        uint256 debtAmount;
        bool receiveAToken;
        uint256 minProfit;
        uint24 poolFee;
    }

    // CONSTRUCTOR

    constructor(address _aavePool, address _uniswapRouter) {
        owner = msg.sender;
        AAVE_POOL = _aavePool;
        UNISWAP_ROUTER = _uniswapRouter;
        aavePool = IPool(_aavePool);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not Owner");
        _;
    }

    function executeMultipleLiquidation(
        LiquidationParams[] calldata params
    ) external onlyOwner {
        for (uint i = 0; i < params.length; i++) {
            LiquidationParams memory p = params[i];
            // mode 1 = liquidation, encode all 5 values that executeOperation expects
            bytes memory data = abi.encode(
                uint8(1),
                p.collateralAsset,
                p.user,
                p.receiveAToken,
                p.minProfit,
                p.poolFee
            );
            aavePool.flashLoanSimple(
                address(this),
                p.debtAsset,
                p.debtAmount,
                data,
                0
            );
        }

        if (address(this).balance > 0) {
            block.coinbase.transfer(address(this).balance / 2);
        }
    }

    function executeLiquidation(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtAmount,
        bool receiveAToken,
        uint256 minProfit,
        uint24 poolFee
    ) external onlyOwner {
        // mode 1 = liquidation
        bytes memory params = abi.encode(
            uint8(1),
            collateralAsset,
            user,
            receiveAToken,
            minProfit,
            poolFee
        );

        aavePool.flashLoanSimple(
            address(this),
            debtAsset,
            debtAmount,
            params,
            0
        );

        /// paying the block builder after profit is captured
        if (address(this).balance > 0) {
            block.coinbase.transfer(address(this).balance / 2);
        }
    }

    /// flash loan callback — Aave calls this automatically mid-flash-loan
    /// Uses mode byte to dispatch: 1 = liquidation, 2 = arbitrage

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /*initiator*/,
        bytes calldata params
    ) external override returns (bool) {
        if (msg.sender != AAVE_POOL) {
            revert AaveLiquidator__NotAavePool();
        }

        uint8 mode = abi.decode(params, (uint8));

        if (mode == 1) {
            _handleLiquidation(asset, amount, premium, params);
        } else if (mode == 2) {
            _handleArbitrage(asset, amount, premium, params);
        } else {
            revert("Unknown mode");
        }

        return true;
    }

    function executeArbitrage(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address dexA, // buy here cheap
        address dexB, // sell here expensive
        uint256 minProfit
    ) external onlyOwner {
        // mode 2 = arbitrage
        bytes memory params = abi.encode(
            uint8(2),
            tokenOut,
            dexA,
            dexB,
            minProfit
        );
        aavePool.flashLoanSimple(address(this), tokenIn, amountIn, params, 0);

        if (address(this).balance > 0) {
            block.coinbase.transfer(address(this).balance / 2);
        }
    }

    function _handleLiquidation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal {
        (
            ,
            address collateralAsset,
            address user,
            bool receiveAToken,
            uint256 minProfit,
            uint24 poolFee
        ) = abi.decode(
                params,
                (uint8, address, address, bool, uint256, uint24)
            );

        // step 1: approve Aave to pull debt tokens for liquidationCall
        IERC20(asset).approve(AAVE_POOL, amount);

        // step 2: liquidate — we pay debt tokens, receive collateral + bonus
        aavePool.liquidationCall(
            collateralAsset,
            asset,
            user,
            amount,
            receiveAToken
        );

        // step 3: swap collateral → debt token via Uniswap to repay flash loan
        uint256 repayAmount = amount + premium;
        _swapCollateralForDebt(collateralAsset, asset, repayAmount, poolFee);

        // step 4: approve Aave to pull back (amount + premium)
        IERC20(asset).approve(AAVE_POOL, repayAmount);

        // step 5: verify profitability
        uint256 profit = IERC20(asset).balanceOf(address(this));
        if (profit < minProfit) {
            revert AaveLiquidator__NotProfitable(profit, minProfit);
        }

        emit LiquidationExecuted(user, asset, collateralAsset, profit);
    }

    /// @dev Handles arbitrage flow inside flash loan callback
    function _handleArbitrage(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal {
        (
            ,
            address tokenOut,
            address dexA,
            address dexB,
            uint256 minProfit
        ) = abi.decode(params, (uint8, address, address, address, uint256));

        uint256 repayAmount = amount + premium;

        // step 1: swap tokenIn → tokenOut on dexA (buy cheap)
        IERC20(asset).approve(dexA, amount);
        _swapOnDex(dexA, asset, tokenOut, amount);

        // step 2: swap tokenOut → tokenIn on dexB (sell expensive)
        uint256 tokenOutBal = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenOut).approve(dexB, tokenOutBal);
        _swapOnDex(dexB, tokenOut, asset, tokenOutBal);

        // step 3: approve Aave for repayment
        IERC20(asset).approve(AAVE_POOL, repayAmount);

        // step 4: verify profitability
        uint256 profit = IERC20(asset).balanceOf(address(this)) - repayAmount;
        if (profit < minProfit) {
            revert AaveLiquidator__NotProfitable(profit, minProfit);
        }

        emit ArbitrageExecuted(asset, tokenOut, profit);
    }

    /// @dev Swap via any Uniswap V3-compatible router
    function _swapOnDex(
        address dex,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal {
        ISwapRouter(dex).exactOutputSingle(
            ISwapRouter.ExactOutputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: 0, // will be set by router
                amountInMaximum: amountIn,
                sqrtPriceLimitX96: 0
            })
        );
    }

    /// @dev Internal helper to swap collateral for debt token. Separated to avoid stack-too-deep.
    function _swapCollateralForDebt(
        address collateralAsset,
        address debtAsset,
        uint256 amountOut,
        uint24 poolFee
    ) internal {
        uint256 collateralBalance = IERC20(collateralAsset).balanceOf(
            address(this)
        );
        IERC20(collateralAsset).approve(UNISWAP_ROUTER, collateralBalance);

        ISwapRouter(UNISWAP_ROUTER).exactOutputSingle(
            ISwapRouter.ExactOutputSingleParams({
                tokenIn: collateralAsset,
                tokenOut: debtAsset,
                fee: poolFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: amountOut,
                amountInMaximum: collateralBalance,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function ADDRESSES_PROVIDER()
        external
        view
        override
        returns (IPoolAddressesProvider)
    {
        return IPool(AAVE_POOL).ADDRESSES_PROVIDER();
    }

    function POOL() external view override returns (IPool) {
        return aavePool;
    }

    /// only admin can work on this

    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) {
            revert AaveLiquidator__NotEnoughBalanceToWithdraw(bal);
        }
        IERC20(token).transfer(owner, bal);
    }

    function withdrawETH() external onlyOwner {
        if (address(this).balance == 0) {
            revert AaveLiquidator__NothingToWithdraw();
        }
        payable(owner).transfer(address(this).balance);
    }

    function simulateLiquidation(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtAmount
    )
        external
        view
        returns (
            uint256 expectedProfit,
            uint256 flashLoanFee,
            bool isProfitable
        )
    {
        flashLoanFee = (debtAmount * 5) / 10000; // 0.05% Aave flash loan fee

        // Default liquidation bonus is ~5% for most assets
        // In production, extract from aavePool.getConfiguration() bitmap
        uint256 liquidationBonus = 10500; // 105% = 5% bonus

        uint256 collateralReceived = (debtAmount * liquidationBonus) / 10000;

        if (collateralReceived > debtAmount + flashLoanFee) {
            expectedProfit = collateralReceived - (debtAmount + flashLoanFee);
            isProfitable = true;
        }
    }

    receive() external payable {}
}
