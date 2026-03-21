//SPDX-License-Identifier : MIT
pragma solidity ^0.8.20;

import {IPool} from "./interfaces/IAavePool.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolAddressesProvider} from "./interfaces/IPoolAddressesProvider.sol";

contract AaveLiquidator is IFlashLoanSimpleReceiver {
    address public owner;
    IPool public aavePool;

    address constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

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
        aavePool.liquidationCall(
            collateralAsset,
            debtAsset,
            user,
            debtAmount,
            recieveToken
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
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // logic goes here , repay flash loan at end
        IERC20(asset).approve(AAVE_POOL, amount + premium);
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
        IERC20(token).transfer(owner, bal);
    }

    function withdrawETH() external onlyOwner {
        payable(owner).transfer(address(this).balance);
    }

    receive() external payable {}
}
