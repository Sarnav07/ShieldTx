#  ShieldTx: Server & Watcher

Welcome to the **Monitoring and Intelligence** engine of the ShieldTx MEV system.

This repository (`server`) is the off-chain "brain" of the operation. It constantly monitors blockchain conditions on Sepolia via WebSockets, decodes raw calldata from the mempool, tracks Aave borrower debt levels, and emits actionable MEV signals to the Flashbots Bundler.

---

##  Brain Architecture

The Server component acts as the **Unified Entry Point** for the entire MEV platform. It performs 3 distinct jobs:

1. **The Watchers (`src/watchers.js`)**: Real-time event and mempool scanning across 4 distinct strategies.
2. **The Event Bus (`src/signalEmitter.js`)**: An internal publish-subscribe (IPC) system that routes the calculated mathematical payloads from the Watchers seamlessly to the Bundler execution engine without cross-contamination.
3. **The Dashboard (`../flashbot-bundler/src/dashboard.js`)**: Bootstraps the Express.js API and hosts the `localhost:3000` real-time UI allowing us to visualize the strategies executing live.

---

##  The 4 Monitored Strategies

1. **Liquidation**: Subscribes to Aave V3 `Borrow`/`Supply` events to dynamically maintain an in-memory database of borrowers. When a user's Health Factor drops below 1.0, it computes the optimal asset to seize and emits a `liquidation` signal.
2. ** Arbitrage**: Continuously queries Uniswap V3 and Sushiswap V2 using `ethers.js` via multicalls. When a price discrepancy exists that exceeds gas costs, it emits an `arbitrage` signal.
3. ** Backrun**: Parses the live pending mempool to hunt for massive swaps traversing known DEX routers. If it spies a >1 ETH trade, it decodes the `exactInputSingle` parameters and emits a `backrun` signal to sandwich the transaction.
4. ** Protection**: Monitors VIP registered users on Aave. When their Health Factor gets dangerously close to 1.1, the Watcher calculates a 25% debt-repayment payload and emits a `protection` signal to save them from liquidation penalties.

---

##  Quick Setup & Usage

### Prerequisites
You need **Node.js (v18+)** and **npm** installed.

### 1. Installation
```bash
git clone <repo>
cd server
npm install
# You also need to install the bundler packages to run the unified boot script
cd ../flashbot-bundler && npm install && cd ../server
```

### 2. Environment Setup
Copy the example environment file and fill in your keys:
```bash
cp .env.example .env
```
*You will minimally need an RPC WSS URL, and the basic HTTP URL/Flashbots keys in the `.env`.*

### 3. Run the Bot
We use a standard command wrapper. To run the unified bot with live real-time mempool watching:
```bash
make start
```

### 4. Run the Hackathon Demo (Mocked signals)
Since real multi-million dollar MEV opportunities do not frequently spawn on Sepolia Testnet naturally, we have an integrated MOCK capability.
Running the mock command will boot the servers, and forcefully blast hardcoded signals into the core Flashbots bundler logic, visualizing the system functioning perfectly under simulated network load.
```bash
make demo
```

---

## Modifying the Watcher Configuration

You can easily adjust strategy configurations in `src/watchers.js`:
- `BACKRUN_MIN_SWAP_ETH`: Adjusts the minimum mempool swap size (currently 1 ETH).
- `HF_PROTECTION_THRESHOLD`: Adjusts what Health Factor triggers an active User Rescue (currently 1.1).
- `WATCH_PAIRS`: An array of token pairs (WETH/USDC, etc) monitored by the arbitrage system.
