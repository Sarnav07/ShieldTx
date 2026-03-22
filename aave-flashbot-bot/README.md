# ShieldTx: Core Smart Contracts

Welcome to the **Smart Contract Engine** of the ShieldTx MEV system. 

This repository (`aave-flashbot-bot`) contains the decentralized foundation of our 4-strategy MEV architecture. It is built using **Foundry**, interacts with **Aave V3** flash loans, and executes multi-DEX swaps across **Uniswap V3** and **Sushiswap V2**.

---
## Architecture Overview

The ShieldTx system is divided into three specialized components:
1. **`aave-flashbot-bot` (You are here)**: The on-chain execution layer. A unified Solidity router (`AaveLiquidator.sol`) that handles flash loans and executes 4 distinct MEV strategies.
2. **`server`**: The off-chain watcher that monitors the mempool and Aave positions for opportunities.
3. **`flashbot-bundler`**: The off-chain Flashbots engine that receives signals from the server and reliably bundles the transactions to bypass the public mempool.

## The 4 Strategies

Our `AaveLiquidator.sol` router dynamically accepts 4 different encoded strategies in a single `executeOperation` flash loan callback:

1. **Liquidation**: Targets underwater Aave positions. Takes a flash loan, repays the debt, seizes the collateral, swaps it for profit, and repays the loan.
2. **Arbitrage**: Identifies price spreads between Uniswap V3 and Sushiswap V2. Flash loans the base asset, buys low, sells high, and pockets the difference.
3. **Backrun**: Sandwiches large, high-slippage DEX trades in the mempool. Follows the exact same logic as Arbitrage but is bundled sequentially right after the target transaction via Flashbots.
4. **Protection (User Rescue)**: A collaborative strategy where users register for protection. When their Health Factor nears liquidation, the bot flash loans, repays a safe portion (e.g., 25%) of their debt, and prevents them from losing their 50% liquidation penalty.

---

## Quick Setup & Deployment

### Prerequisites
You must have [Foundry](https://book.getfoundry.sh/getting-started/installation) installed.

### 1. Installation
```bash
git clone <repo>
cd aave-flashbot-bot
forge install
```

### 2. Environment Setup
Copy the example environment file and fill in your keys:
```bash
cp .env.example .env
```
*You will need a Sepolia RPC URL and your deployer wallet's Private Key.*

### 3. Build & Test
We use Mainnet Forking to test against real liquidity pools.
```bash
forge build
forge test --fork-url $ALCHEMY_RPC_URL -vvv
```

### 4. Deploy to Sepolia Testnet
This script broadcasts the deployment, verifies the contract on Etherscan, and automatically exports the ABI to the `flashbot-bundler`.
```bash
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
```

### 5. Simulate Executions
You can simulate the profitability of a liquidation off-chain before ever sending a transaction:
```bash
forge script script/Simulator.s.sol --rpc-url $SEPOLIA_RPC_URL -vvvv
```

---

##  Security & Hardening

Our smart contracts are designed with production-grade security:
- **`ReentrancyGuard`**: Protects the main entry points (`withdraw`, `executeOperation`).
- **Circuit Breakers**: `paused` state modifier implemented to freeze the contract instantly in case of an emergency.
- **Max Approvals**: Avoids expensive per-transaction approvals, saving ~40k gas per execution.
- **Access Control**: Strict `onlyOwner` modifiers on all execution triggers.

---

##  Live Deployments

| Network | Contract Address | Status |
|---------|---------|----------|
| **Sepolia** | Check `config/networks.json` | Verified |