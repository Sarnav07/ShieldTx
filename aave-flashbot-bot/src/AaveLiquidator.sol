//SPDX-License-Identifier : MIT
pragma solidity ^0.8.20;

import {IPool} from "./interfaces/IAavePool.sol";
import {IFlashLoanSimpleReceiver} from "./interfaces/IFlashLoanSimpleReceiver.sol";
import {IERC20} from "../lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolAddressesProvider} from "./interfaces/IPoolAddressesProvider.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";
import {IUniswapV2Router} from "./interfaces/IUniswapV2Router.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

contract AaveLiquidator is IFlashLoanSimpleReceiver, ReentrancyGuard {
    // IMMUTABLES

    address public immutable AAVE_POOL;
    address public immutable UNISWAP_ROUTER;

    // CONSTANTS

    address constant SUSHISWAP_ROUTER =
        0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F;

    // Well-known mainnet token addresses for max approvals
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    // ERRORS

    error AaveLiquidator__NotAavePool();
    error AaveLiquidator__NotProfitable(uint256 profit, uint256 minProfit);
    error AaveLiquidator__NotEnoughBalanceToWithdraw(uint256 bal);
    error AaveLiquidator__NothingToWithdraw();

    // STATE

    address public owner;
    IPool public aavePool;
    bool public paused;

    // MAPPINGS

    mapping(address => bool) public protectedUsers;
    mapping(address => uint256) public protectionThreshold;

    // EVENTS

    event LiquidationExecuted(
        address indexed user,
        address debtAsset,
        address collateralAsset,
        uint256 profit
    );

    event ProtectionExecuted(
        address indexed user,
        address debtAsset,
        uint256 amountRepaid,
        uint256 newHealthFactor
    );

    event BackrunExecuted(
        bytes32 indexed targetTx,
        address tokenIn,
        uint256 profit
    );

    event FlashLoanRepaid(address indexed asset, uint256 amount);

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

    // STRATEGY CONSTANTS

    uint8 constant STRATEGY_LIQUIDATION = 1;
    uint8 constant STRATEGY_ARBITRAGE = 2;
    uint8 constant STRATEGY_BACKRUN = 3;
    uint8 constant STRATEGY_PROTECTION = 4;

    // CONSTRUCTOR

    constructor(address _aavePool, address _uniswapRouter) {
        owner = msg.sender;
        AAVE_POOL = _aavePool;
        UNISWAP_ROUTER = _uniswapRouter;
        aavePool = IPool(_aavePool);
    }

    function approveTokenMax(
        address token,
        address spender
    ) external onlyOwner {
        IERC20(token).approve(spender, type(uint256).max);
    }

    // MODIFIERS

    modifier onlyOwner() {
        require(msg.sender == owner, "Not Owner");
        _;
    }

    modifier notPaused() {
        require(!paused, "Contract Paused");
        _;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    function fund(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }

    function executeMultipleLiquidation(
        LiquidationParams[] calldata params
    ) external onlyOwner notPaused {
        for (uint i = 0; i < params.length; i++) {
            LiquidationParams memory p = params[i];
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
        uint256 minProfit
    ) external onlyOwner notPaused {
        bytes memory params = abi.encode(
            STRATEGY_LIQUIDATION,
            collateralAsset,
            user,
            receiveAToken
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
    /// flash loan router

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /*initiator*/,
        bytes calldata params
    ) external override nonReentrant returns (bool) {
        if (msg.sender != AAVE_POOL) {
            revert AaveLiquidator__NotAavePool();
        }

        uint8 strategyType = abi.decode(params, (uint8));

        if (strategyType == STRATEGY_LIQUIDATION) {
            _executeLiquidation(asset, amount, premium, params);
        } else if (strategyType == STRATEGY_ARBITRAGE) {
            _executeArbitrage(asset, amount, premium, params);
        } else if (strategyType == STRATEGY_BACKRUN) {
            _executeBackrun(asset, amount, premium, params);
        } else if (strategyType == STRATEGY_PROTECTION) {
            _executeProtection(asset, amount, premium, params);
        } else {
            revert("Unknown strategy");
        }

        // repay flash loan — always runs regardless of strategy
        IERC20(asset).approve(AAVE_POOL, amount + premium);

        return true;
    }

    function _executeLiquidation(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal {
        (, address collateralAsset, address user, bool receiveAToken) = abi
            .decode(params, (uint8, address, address, bool));

        IERC20(asset).approve(AAVE_POOL, amount);

        aavePool.liquidationCall(
            collateralAsset,
            asset,
            user,
            amount,
            receiveAToken
        );

        uint256 collateralBalance = IERC20(collateralAsset).balanceOf(
            address(this)
        );
        IERC20(collateralAsset).approve(UNISWAP_ROUTER, collateralBalance);

        ISwapRouter(UNISWAP_ROUTER).exactOutputSingle(
            ISwapRouter.ExactOutputSingleParams({
                tokenIn: collateralAsset,
                tokenOut: asset,
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: amount + premium,
                amountInMaximum: collateralBalance,
                sqrtPriceLimitX96: 0
            })
        );

        emit LiquidationExecuted(
            user,
            asset,
            collateralAsset,
            IERC20(asset).balanceOf(address(this))
        );
    }

    function executeArbitrage(
        address tokenIn, // token to flash borrow
        address tokenOut, // intermediate token
        uint256 amountIn, // flash loan amount
        bool buyOnUniswap, // true = buy cheap on Uni, sell on Sushi
        uint24 uniswapFee, // Uniswap V3 pool fee (500, 3000, 10000)
        uint256 minProfit // revert if profit below this
    ) external onlyOwner notPaused {
        bytes memory params = abi.encode(
            STRATEGY_ARBITRAGE,
            tokenOut,
            buyOnUniswap,
            uniswapFee,
            minProfit
        );
        aavePool.flashLoanSimple(address(this), tokenIn, amountIn, params, 0);

        if (address(this).balance > 0) {
            block.coinbase.transfer(address(this).balance / 2);
        }
    }

    function _executeArbitrage(
        address asset, // = tokenIn (flash borrowed)
        uint256 amount,
        uint256 premium,
        bytes memory params
    ) internal {
        (
            ,
            address tokenOut,
            bool buyOnUniswap,
            uint24 uniswapFee,
            uint256 minProfit
        ) = abi.decode(params, (uint8, address, bool, uint24, uint256));

        uint256 minReturn = amount + premium + minProfit;

        if (buyOnUniswap) {
            _arbBuyUniSellSushi(asset, tokenOut, amount, uniswapFee, minReturn);
        } else {
            _arbBuySushiSellUni(asset, tokenOut, amount, uniswapFee, minReturn);
        }

        emit ArbitrageExecuted(
            asset,
            tokenOut,
            IERC20(asset).balanceOf(address(this))
        );
    }

    /// @dev Buy tokenOut on Uniswap V3 (cheap), sell on Sushiswap V2 (expensive)
    function _arbBuyUniSellSushi(
        address tokenIn,
        address tokenOut,
        uint256 amount,
        uint24 uniswapFee,
        uint256 minReturn
    ) internal {
        IERC20(tokenIn).approve(UNISWAP_ROUTER, amount);
        uint256 received = ISwapRouter(UNISWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: uniswapFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        IERC20(tokenOut).approve(SUSHISWAP_ROUTER, received);
        address[] memory path = new address[](2);
        path[0] = tokenOut;
        path[1] = tokenIn;

        uint256[] memory amounts = IUniswapV2Router(SUSHISWAP_ROUTER)
            .swapExactTokensForTokens(
                received,
                minReturn,
                path,
                address(this),
                block.timestamp
            );

        require(amounts[amounts.length - 1] >= minReturn, "Arb not profitable");
    }

    /// @dev Buy tokenOut on Sushiswap V2 (cheap), sell on Uniswap V3 (expensive)
    function _arbBuySushiSellUni(
        address tokenIn,
        address tokenOut,
        uint256 amount,
        uint24 uniswapFee,
        uint256 minReturn
    ) internal {
        IERC20(tokenIn).approve(SUSHISWAP_ROUTER, amount);
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IUniswapV2Router(SUSHISWAP_ROUTER)
            .swapExactTokensForTokens(
                amount,
                0,
                path,
                address(this),
                block.timestamp
            );
        uint256 received = amounts[amounts.length - 1];

        IERC20(tokenOut).approve(UNISWAP_ROUTER, received);
        uint256 finalAmount = ISwapRouter(UNISWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenOut,
                tokenOut: tokenIn,
                fee: uniswapFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: received,
                amountOutMinimum: minReturn,
                sqrtPriceLimitX96: 0
            })
        );

        require(finalAmount >= minReturn, "Arb not profitable");
    }

    function executeBackrun(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bool buyOnUniswap,
        uint24 uniswapFee,
        uint256 minProfit,
        bytes32 targetTxHash // just for event logging — which tx we backran
    ) external onlyOwner notPaused {
        bytes memory params = abi.encode(
            STRATEGY_BACKRUN,
            tokenOut,
            buyOnUniswap,
            uniswapFee,
            minProfit,
            targetTxHash
        );
        aavePool.flashLoanSimple(address(this), tokenIn, amountIn, params, 0);

        if (address(this).balance > 0) {
            block.coinbase.transfer(address(this).balance / 2);
        }
    }

    function _executeBackrun(
        address asset,
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal {
        (
            ,
            address tokenOut,
            bool buyOnUniswap,
            uint24 uniswapFee,
            uint256 minProfit,
            bytes32 targetTxHash
        ) = abi.decode(
                params,
                (uint8, address, bool, uint24, uint256, bytes32)
            );

        bytes memory arbParams = abi.encode(
            STRATEGY_ARBITRAGE,
            tokenOut,
            buyOnUniswap,
            uniswapFee,
            minProfit
        );
        _executeArbitrage(asset, amount, premium, arbParams);

        emit BackrunExecuted(
            targetTxHash,
            asset,
            IERC20(asset).balanceOf(address(this))
        );
    }

    function registerProtection(
        address user,
        uint256 threshold // e.g. 1.2e18 = protect when HF drops below 1.2
    ) external onlyOwner notPaused {
        protectedUsers[user] = true;
        protectionThreshold[user] = threshold;
    }

    function executeProtection(
        address user,
        address debtAsset,
        uint256 repayAmount // how much debt to repay
    ) external onlyOwner notPaused {
        require(protectedUsers[user], "User not registered");

        bytes memory params = abi.encode(STRATEGY_PROTECTION, user, debtAsset);
        aavePool.flashLoanSimple(
            address(this),
            debtAsset,
            repayAmount,
            params,
            0
        );
    }

    function _executeProtection(
        address asset, // = debtAsset
        uint256 amount,
        uint256 premium,
        bytes calldata params
    ) internal {
        (, address user, ) = abi.decode(params, (uint8, address, address));
        IERC20(asset).approve(AAVE_POOL, amount);
        aavePool.repay(asset, amount, 2, user);

        // Check new health factor
        (, , , , , uint256 newHF) = aavePool.getUserAccountData(user);

        emit ProtectionExecuted(user, asset, amount, newHF);
    }

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

    function withdraw(address token) external onlyOwner nonReentrant {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) {
            revert AaveLiquidator__NotEnoughBalanceToWithdraw(bal);
        }
        IERC20(token).transfer(owner, bal);
    }

    function withdrawETH() external onlyOwner nonReentrant {
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

        uint256 liquidationBonus = 10500; // 105% = 5% bonus

        uint256 collateralReceived = (debtAmount * liquidationBonus) / 10000;

        if (collateralReceived > debtAmount + flashLoanFee) {
            expectedProfit = collateralReceived - (debtAmount + flashLoanFee);
            isProfitable = true;
        }
    }

    receive() external payable {}
}
