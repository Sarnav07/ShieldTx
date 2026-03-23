const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
require("dotenv").config({ path: path.join(__dirname, "server", ".env") });

const FORK_URL = "http://127.0.0.1:8545";
const WHALE = "0x0000000000000000000000000000000000001337";

const ADDR = {
    AAVE_POOL: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    UNISWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    SUSHI_ROUTER: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};

const WETH_ABI = [
    "function deposit() payable",
    "function approve(address, uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
];
const SUSHI_ABI = [
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
];
const AAVE_POOL_ABI = [
    "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
    "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
    "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)"
];

async function main() {
    console.log(`\nSHIELDTX - LIVE NETWORK CHAOS INJECTOR `);

    let provider;
    try {
        provider = new ethers.providers.JsonRpcProvider(FORK_URL);
        await provider.getBlockNumber();
    } catch (e) {
        console.error("Anvil is not running! Start it: anvil --fork-url $MAINNET_RPC_URL");
        process.exit(1);
    }

    // 1. Fund our whale account
    await provider.send("anvil_setBalance", [WHALE, ethers.utils.hexValue(ethers.utils.parseEther("10000"))]);
    await provider.send("anvil_impersonateAccount", [WHALE]);
    const whaleSigner = provider.getSigner(WHALE);

    // 2. Deploy AaveLiquidator to the fork!
    console.log("\n[1] Deploying AaveLiquidator smart contract to Anvil fork...");
    const artifactPath = path.join(__dirname, "aave-flashbot-bot/out/AaveLiquidator.sol/AaveLiquidator.json");
    if (!fs.existsSync(artifactPath)) {
        console.error(" Need to compile contract first: cd aave-flashbot-bot && forge build");
        process.exit(1);
    }
    const compiled = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));

    // Deploy using the actual bot wallet so the bot is the 'owner'
    const botWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    await provider.send("anvil_setBalance", [botWallet.address, ethers.utils.hexValue(ethers.utils.parseEther("100"))]);

    const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode.object, botWallet);
    const contract = await factory.deploy(ADDR.AAVE_POOL, ADDR.UNISWAP_ROUTER);
    await contract.deployed();
    const contractAddress = contract.address;
    console.log(`AaveLiquidator deployed at: ${contractAddress}`);

    // Update config to use this address for the demo
    fs.writeFileSync(path.join(__dirname, ".demo-contract.json"), JSON.stringify({ contractAddress }));

    // 3. Create a 200 ETH Whale Swap to trigger Arbitrage
    console.log("\n[2] Injecting Arbitrage Opportunity (Sushiswap 200 ETH Dump)...");
    const WHALE_SWAP = ethers.utils.parseEther("200.0");
    const weth = new ethers.Contract(ADDR.WETH, WETH_ABI, whaleSigner);
    await weth.deposit({ value: WHALE_SWAP });
    await weth.approve(ADDR.SUSHI_ROUTER, WHALE_SWAP);

    const sushi = new ethers.Contract(ADDR.SUSHI_ROUTER, SUSHI_ABI, whaleSigner);
    const deadline = Math.floor(Date.now() / 1000) + 600;
    await sushi.swapExactTokensForTokens(WHALE_SWAP, 0, [ADDR.WETH, ADDR.USDC], WHALE, deadline);
    console.log(`Whale dumped 200 WETH on SushiV2 — Price crashed!`);

    // 4. Create a toxic Aave loan to trigger Liquidation
    console.log("\n[3] Injecting Liquidation Opportunity (Aave V3 Toxic Loan)...");
    const SUPPLY_WETH = ethers.utils.parseEther("5.0");
    await weth.deposit({ value: SUPPLY_WETH });
    await weth.approve(ADDR.AAVE_POOL, SUPPLY_WETH);

    const pool = new ethers.Contract(ADDR.AAVE_POOL, AAVE_POOL_ABI, whaleSigner);
    await pool.supply(ADDR.WETH, SUPPLY_WETH, WHALE, 0);

    const accountData = await pool.getUserAccountData(WHALE);
    const borrowBase = accountData.availableBorrowsBase.mul(98).div(100); // Borrow 98% to be extremely close to 1.0 HF
    const borrowUSDC = borrowBase.mul(1000000).div(100000000);
    await pool.borrow(ADDR.USDC, borrowUSDC, 2, 0, WHALE);

    const newAccountData = await pool.getUserAccountData(WHALE);
    const hf = parseFloat(ethers.utils.formatUnits(newAccountData.healthFactor, 18)).toFixed(4);
    console.log(`Whale borrowed USDC on Aave. Health Factor = ${hf}`);

    console.log("\nChaos successfully injected into the Anvil blockchain!");
    console.log("The ShieldTx backend watcher should detect these immediately.\n");
}

main().catch(console.error);
