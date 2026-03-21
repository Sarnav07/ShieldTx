//SPDX-License-Identifier : MIT
pragma solidity ^0.8.20;

import {IPool} from "./interfaces/IAavePool.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolAddressesProvider} from "./interfaces/IPoolAddressesProvider.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";

contract AaveLiquidator is IFlashLoanSimpleReceiver {
    // ERRORS

    error AaveLiquidator__NotAavePool();
    error AaveLiquidator__NotProfitable(uint256 profit, uint256 minProfit);
    error AaveLiquidator__NotEnoughBalanceToWithdraw(uint256 bal);
    error AaveLiquidator__NothingToWithdraw();

    // STATE

    address public owner;
    IPool public aavePool;

    // CONSTANTS

    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant UNISWAP_ROUTER =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // EVENTS

    event LiquidationExecuted(
        address indexed user,
        address debtAsset,
        address collateralAsset,
        uint256 profit
    );

    // CONSTRUCTOR

    constructor() {
        owner = msg.sender;
        aavePool = IPool(AAVE_POOL);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not Owner");
        _;
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
        bytes memory params = abi.encode(
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

    /// flash loan callback , aave calls this automatically mid-flash-loan

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

        (
            address collateralAsset,
            address user,
            bool receiveAToken,
            uint256 minProfit,
            uint24 poolFee
        ) = abi.decode(params, (address, address, bool, uint256, uint24));

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

        // step 4: approve Aave to pull back (amount + premium) for flash loan repayment
        IERC20(asset).approve(AAVE_POOL, repayAmount);

        // step 5: verify profitability — revert the entire tx if not worth it
        uint256 profit = IERC20(asset).balanceOf(address(this));
        if (profit < minProfit) {
            revert AaveLiquidator__NotProfitable(profit, minProfit);
        }

        emit LiquidationExecuted(user, asset, collateralAsset, profit);

        return true;
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

    receive() external payable {}
}
