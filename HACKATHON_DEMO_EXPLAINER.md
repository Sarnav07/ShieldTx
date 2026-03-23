# The Ultimate Hackathon Demo

## 🛠️ Step 0: Prerequisites & Setup

Before running the demo, ensure you have **Node.js (v18+)**, **Foundry**, and **Git** installed on your system.

**1. Install Dependencies**
```bash
# Root: Install injector script dependencies
npm install ethers dotenv

# Server: Install watcher & math dependencies
cd server
npm install ethers dotenv

# Bundler: Install Flashbots & UI runtime dependencies
cd ../flashbot-bundler
npm install @flashbots/ethers-provider-bundle ethers dotenv express

# Contracts: Install Solidity framework libraries
cd ../aave-flashbot-bot
forge install foundry-rs/forge-std aave/aave-v3-core OpenZeppelin/openzeppelin-contracts
forge build
cd ..
```

**2. Configure your Environment Variables**
The backend and the injector script require a `.env` file located natively inside the `server/` folder.

Create a file named `server/.env` and paste the following:
```env
# Network Endpoints
RPC_WSS=wss://sepolia.infura.io/ws/v3/YOUR_INFURA_KEY
SEPOLIA_RPC_URL=https://sepolia.infura.io/v3/YOUR_INFURA_KEY

# Wallets
PRIVATE_KEY=your_real_wallet_private_key
FLASHBOTS_AUTH_KEY=0x9000000000000000000000000000000000000011 # This can be any random 32-byte hex for reputation tracking

# UI
DASHBOARD_PORT=3000
```
*(For the local Anvil fork demo, your real `PRIVATE_KEY` doesn't strictly need real Mainnet ETH because the chaos injector artificially funds it. However, it must be a valid 64-character EVM private key).*

---

## 🚀 Quick Start: How to Run the Live Demo
You need exactly 3 terminal windows to execute the full architecture seamlessly.

**Terminal 1: Start the Blockchain**
```bash
anvil --fork-url https://mainnet.infura.io/v3/eab4495632284c1b82d7c680dd87eb42 --port 8545
```
*(Leave this running in the background)*

**Terminal 2: Start the Backend & Dashboard**
```bash
cd server
NETWORK=mainnet DEMO_BYPASS_FLASHBOTS=true node index.js
```
*(Open http://localhost:3000 to see the Dashboard)*

**Terminal 3: Inject the Chaos (The Whale Simulator)**
```bash
# Make sure you are in the root ShieldTx directory
node inject-chaos.js
```
*(As soon as you execute this, immediately look at your Dashboard and Terminal 2! You will watch the bot detect the 200 ETH price crash, parse the mathematical spread, and route the Flashbots bundle on-chain!)*

---

## How It Works under the Hood

## 1. The Setup: The Anvil Mainnet Fork
`anvil --fork-url https://mainnet.infura.io...`
* **What it is:** A locally hosted, isolated clone of the Ethereum Mainnet. It downloads the exact state of all smart contracts (like Uniswap pools and Aave lending protocols) into your computer's RAM.
* **Why we use it:** To test MEV strategies against millions of dollars of real, deep liquidity without risking real assets or paying real gas fees.

## 2. The Components
The demo involves three independent pieces of software running simultaneously:

1. **The Backend Engine (`server/index.js`):** Your actual production Node.js server. It consists of the Watcher (scanning mempool/blocks), the Signal Emitter (internal event bus), the Bundler (Flashbots payload builder), and the web dashboard (`localhost:3000`).
2. **The "Chaos" Injector (`inject-chaos.js`):** A standalone script acting as a completely unrelated third party (a "Whale"). Its only job is to do irrational things on the blockchain so your bot can profit from them.
3. **The Smart Contract (`AaveLiquidator.sol`):** Your compiled Solidity code that handles the flash loans, token swaps, and profit extraction on-chain.

---

## 3. Step-by-Step Flow: What actually happens when you run the demo?

### Phase A: Injection (The Fake Part)
When you run `node inject-chaos.js`:
1. **Printing Money:** The script uses Anvil "cheatcodes" (`anvil_setBalance`) to magically give `0x1337...` (the "Whale" wallet) 10,000 fake ETH. 
2. **Contract Deployment:** It deploys your `AaveLiquidator.sol` smart contract to the local blockchain and writes the new address to a hidden config file (`.demo-contract.json`).
3. **The Catalyst:** The Whale dumps 200 ETH into the Sushiswap V2 WETH/USDC router in a single massive trade. This entirely drains that specific pool's ETH reserves and crashes the price of WETH *only on Sushiswap*. 
4. Meanwhile, the Uniswap V3 WETH/USDC pool remains completely untouched and is trading at normal market prices. A massive arbitrage spread is born.

### Phase B: Detection (The Real Part)
Your Backend Engine (`node index.js`) is listening to the Anvil fork.
1. The `watchers.js` file constantly queries the pricing on both Sushiswap and Uniswap.
2. The watcher detects the massive spread (Sushiswap WETH is extremely cheap, Uniswap WETH is normal price).
3. The watcher fires an `arbitrage` event containing the token addresses and swap router fees through your Node.js `EventEmitter`.

### Phase C: Simulation & Execution (The Hybrid Part)
The `bundler.js` process catches the `arbitrage` event and executes the following:
1. **Profit Calculation (Real):** It runs `calculateArbProfit()`, which executes an on-chain `Quoter.quoteExactInputSingle()` call to exactly calculate the execution gas, swap slippage, and net ETH profit.
2. **Encoding (Real):** It uses `ethers.js` to ABI-encode a call to `executeArbitrage()` on your smart contract.
3. **Bundle Building (Real):** It constructs a Flashbots bundle payload (an array of signed transactions).
4. **Relay Submission (Faked/Bypassed):** Normally, this bundle is sent to the official Flashbots Relay API (`relay.flashbots.net`). **This step is bypassed using the `DEMO_BYPASS_FLASHBOTS=true` flag.** Why? Because the official Flashbots servers simulate transactions against the *public internet Ethereum chain*, which has no idea about your local Anvil fork's Sushiswap crash. The Flashbots server would reject the bundle as invalid.
5. **On-Chain Execution (Real):** To prove the profit math is correct, the Bundler unpacks the signed Flashbots bundle and sends the raw transactions directly to your local Anvil node (`provider.sendTransaction()`).
6. **Smart Contract Logic (Real):** Your Solidity contract `AaveLiquidator.sol` receives the transaction, takes an Aave V3 WETH Flash Loan, buys extremely cheap USDC on Sushiswap, sells it back for normal price on Uniswap V3, repays the Flash Loan, and locks in the ETH profit. 

---

## 4. Summary 

**WHAT IS 100% REAL:**
* **The On-Chain Math:** Our Node.js backend queries real Uniswap quoting contracts to determine profitability.
* **The Architecture:** The event-driven Watcher -> Emitter -> Bundler Node.js pipeline is exactly how production MEV bots are structured.
* **The Solidity Execution:** The `AaveLiquidator.sol` contract genuinely executes the multi-leg flash-loan arbitrage on the local fork, paying simulated gas and updating its internal ETH balance.
* **The Dashboard:** The UI updates are driven by genuine backend events, not hardcoded strings.

**WHAT IS "FAKED" OR MODIFIED FOR THE DEMO:**
* **The Opportunity:** You forced the market imbalance by dumping 200 fake ETH via a script, rather than waiting weeks for a real person to make a mistake on-chain.
* **The Flashbots Relay:** The bundle is constructed perfectly, but it is routed out to the local blockchain via standard RPC instead of the Flashbots Private Mempool Network so that the demonstration can execute locally.
