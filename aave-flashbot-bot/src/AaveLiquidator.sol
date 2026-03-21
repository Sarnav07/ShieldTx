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

    event LiquidationExecueted(
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

    /// function below will be called by person c , and signature must be stable

    function executeLiquidation(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtAmount,
        bool recieveToken
    ) external onlyOwner {
        bytes memory params = abi.encode(collateralAsset, user, recieveToken);

        aavePool.flashLoanSimple(
            address(this),
            debtAsset,
            debtAmount,
            params,
            0
        );
        /// paying the miner the money after profit is made

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
        // logic goes here , repay flash loan at end
        if (msg.sender != AAVE_POOL) {
            revert AaveLiquidator__NotAavePool();
        }

        (address collateralAssest, address user, bool recieveToken) = abi
            .decode(params, (address, address, bool));

        // step 1 : approving aave to pull debt tokens
        IERC20(asset).approve(AAVE_POOL, amount + premium);

        // step 2 : we pay debt tokens recieve collateralAssests + bonus
        aavePool.liquidationCall(
            collateralAssest,
            asset,
            user,
            amount,
            recieveToken
        );

        // step 3 : swap collateral debt via uniswap , need exactly (amount + premium) of debt to repay
        uint256 collateralBalance = IERC20(collateralAssest).balanceOf(
            address(this)
        );
        IERC20(collateralAssest).approve(UNISWAP_ROUTER, collateralBalance);

        ISwapRouter(UNISWAP_ROUTER).exactOutputSimple(
            ISwapRouter.ExactOutputSimpleParams({
                tokenIn: collateralAssest,
                tokenOut: asset,
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: amount + premium,
                amountInMaximum: 0,
                sqrtPriceX96After: 0
            })
        );

        // step 4 : approve aave to pull repayment

        IERC20(asset).approve(AAVE_POOL, amount + premium);

        // step 5 : emit profit

        emit LiquidationExecueted(
            user,
            asset,
            collateralAssest,
            IERC20(asset).balanceOf(address(this))
        );

        return true;
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
        if (bal < 0) {
            revert AaveLiquidator__NotEnoughBalanceToWithdraw(bal);
        }
        IERC20(token).transfer(owner, bal);
    }

    function withdrawETH() external onlyOwner {
        if (address(this).balance < 0) {
            revert AaveLiquidator__NothingToWithdraw();
        }
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}
