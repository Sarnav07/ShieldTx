# ShieldTx — MEV Detection & Execution System

A **4-strategy MEV (Maximal Extractable Value)** bot that monitors Ethereum for profitable opportunities and executes them atomically through Flashbots private bundles. Built to detect Aave V3 liquidations, cross-DEX arbitrage, mempool backruns, and user protection rescues.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          server/index.js                                │
│                       Unified Entry Point                               │
├──────────────────────────┬──────────────────────────────────────────────┤
│                          │                                              │
│  ┌─────────────────┐     │    ┌─────────────────────────────────────┐   │
│  │  server/         │     │    │  flashbot-bundler/                  │   │
│  │  watchers.js     │     │    │  bundler.js                        │   │
│  │                  │  signals  │                                    │   │
│  │  • Liquidation   │────────►│  • Profit calculation               │   │
│  │  • Arbitrage     │  via    │  • Transaction encoding             │   │
│  │  • Backrun       │ shared  │  • Bundle simulation                │   │
│  │  • Protection    │ emitter │  • Flashbots relay submission       │   │
│  │                  │         │                                     │   │
│  └─────────────────┘         └──────────────┬──────────────────────┘   │
│                                              │                         │
│                 ┌────────────────────────────┐│ ┌─────────────────────┐ │
│                 │ Dashboard (localhost:3000)  ││ │ AaveLiquidator.sol  │ │
│                 │ Live stats + log feed      ││ │ On-chain router     │ │
│                 └────────────────────────────┘│ └─────────────────────┘ │
│                                               │          ▲              │
│                                               │  Flashbots Bundle      │
│                                               ▼                        │
│                                     ┌────────────────────┐             │
│                                     │  Flashbots Relay    │             │
│                                     │  (Private mempool)  │             │
│                                     └────────────────────┘             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Three Components

| Component | Language | Purpose |
|-----------|----------|---------|
| **`server/`** | Node.js | Watches Ethereum via WebSocket — scans Aave positions, mempool, and DEX pools. Emits structured signals when opportunities are found. |
| **`flashbot-bundler/`** | Node.js | Receives signals, calculates profitability, encodes smart contract calls, simulates bundles via Flashbots, and submits them to the relay. Hosts a live dashboard. |
| **`aave-flashbot-bot/`** | Solidity | On-chain execution router — a single `AaveLiquidator.sol` contract that handles flash loans and swaps for all 4 strategies. Deployed on Sepolia. |

---

## The 4 Strategies

### 1. Liquidation

**Goal:** Detect underwater Aave V3 borrowers and profitably liquidate them.

```
Health Factor < 1.0 detected
     │
     ▼
┌─ Flash loan debt asset from Aave ─┐
│  Repay borrower's debt             │
│  Seize discounted collateral       │
│  Swap collateral → debt asset      │
│  Repay flash loan + premium        │
│  Keep the profit                   │
└────────────────────────────────────┘
```

**How it works:**
1. **Watcher** subscribes to Aave `Borrow`/`Supply` events to build an in-memory watchlist of borrower addresses
2. Every block, it calls `getUserAccountData()` on each tracked position
3. When `healthFactor < 1.0`, it picks the best debt/collateral pair and emits a `liquidation` signal
4. **Bundler** receives the signal, runs `profitCalculator.js` to estimate net profit after gas + flash loan premium
5. If profitable, encodes `executeLiquidation()` and sends a Flashbots bundle

**Key files:**
- `server/src/watchers.js` → `scanPositions()`
- `server/src/healthFactor.js` → health factor math, `pickBestDebt()`, `pickBestCollateral()`
- `flashbot-bundler/src/profitCalculator.js` → full profit estimation
- `aave-flashbot-bot/src/AaveLiquidator.sol` → `executeLiquidation()` → flash loan callback

---

### 2. Arbitrage (Cross-DEX)

**Goal:** Exploit price differences between Uniswap V3 and Sushiswap V2.

```
Price on Uniswap V3 ≠ Price on Sushiswap V2
     │
     ▼
┌─ Flash loan tokenIn from Aave ────┐
│  Buy tokenOut on cheaper DEX       │
│  Sell tokenOut on expensive DEX    │
│  Repay flash loan                  │
│  Keep the spread                   │
└────────────────────────────────────┘
```

**How it works:**
1. **Watcher** calls `findArbOpportunity()` every block for configured token pairs (WETH/USDC)
2. The arb calculator queries **both DEXs**:
   - Uniswap V3: `QuoterV2.quoteExactInputSingle()` across 4 fee tiers (0.01%, 0.05%, 0.3%, 1%)
   - Sushiswap V2: `Router.getAmountsOut()` for direct swap
3. Checks two routes:
   - **Route A** (`buyOnUniswap=true`): Buy on Uni V3 → sell on Sushi V2
   - **Route B** (`buyOnUniswap=false`): Buy on Sushi V2 → sell on Uni V3
4. The most profitable route/fee-tier/size combination wins
5. **Bundler** runs `calculateArbProfit()`, encodes `executeArbitrage()`, and bundles

**Key files:**
- `flashbot-bundler/src/arbCalculator.js` → `findArbOpportunity()`, `checkCrossDexRoundTrip()`, `getSushiQuote()`
- `aave-flashbot-bot/src/AaveLiquidator.sol` → `executeArbitrage()` → `_arbBuyUniSellSushi()` / `_arbBuySushiSellUni()`

---

### 3. Backrun

**Goal:** Profit from the price impact of large pending swaps in the mempool.

```
Large swap (>0.1 ETH) detected in mempool
     │
     ▼
┌─ Flashbots 2-tx Bundle ──────────┐
│  Tx 1: Victim's swap (raw bytes)  │
│  Tx 2: Our backrun trade          │
│  (We trade after their impact)    │
└───────────────────────────────────┘
```

**How it works:**
1. **Watcher** monitors `provider.on("pending", txHash)` for all pending transactions
2. Filters for txs sent to known DEX routers (`KNOWN_ROUTERS`) with value > `BACKRUN_MIN_SWAP_ETH`
3. Decodes the swap calldata to extract `tokenIn`, `tokenOut`, `amountIn`
4. Emits a `backrun` signal with the decoded details + `txHash`
5. **Bundler** receives the signal, fetches the raw signed transaction via `eth_getRawTransactionByHash`
6. Builds a **2-transaction bundle**: victim's tx first (creates price impact), our backrun tx second (captures profit)
7. This ordering is enforced by Flashbots — both txs land in the same block, in sequence

**Key design decision:** Backrun bundles use `buildAndSendBackrunBundle()` (separate from the standard `buildAndSendBundle()`) because they must include a pre-signed external transaction as the first entry.

**Key files:**
- `server/src/watchers.js` → `startBackrunWatcher()`
- `flashbot-bundler/src/bundler.js` → `handleBackrunSignal()`, `buildAndSendBackrunBundle()`
- `aave-flashbot-bot/src/AaveLiquidator.sol` → `executeBackrun()`

---

### 4. Protection (User Rescue)

**Goal:** Pre-emptively repay a portion of registered users' debt before they face the 50% liquidation penalty.

```
Protected user's Health Factor approaching 1.1
     │
     ▼
┌─ Flash loan debt asset ───────────┐
│  Repay 25% of user's debt         │
│  User avoids liquidation penalty   │
│  Repay flash loan from contract    │
│  (This is a service, not profit)   │
└────────────────────────────────────┘
```

**How it works:**
1. Users register for protection via `registerProtection(address, threshold)` on the contract
2. **Watcher** monitors these users' health factors every block
3. When HF drops below 1.1, it calculates a 25% debt repayment and emits a `protection` signal
4. The contract repays the minimal amount needed to push the user's HF back above the danger zone

**Key files:**
- `server/src/watchers.js` → `startProtectionMonitor()`
- `aave-flashbot-bot/src/AaveLiquidator.sol` → `executeProtection()`

---

## Signal Flow

The watcher and bundler communicate via a shared in-process `EventEmitter` (no HTTP, no message queues).

```
watchers.js                signalEmitter.js              bundler.js
    │                           │                            │
    ├──emit("liquidation")─────►├──on("liquidation")────────►│→ profitCalc → bundle
    ├──emit("arbitrage")───────►├──on("arbitrage")──────────►│→ arbProfit  → bundle
    ├──emit("backrun")─────────►├──on("backrun")────────────►│→ fetchRawTx → 2-tx bundle
    ├──emit("protection")──────►├──on("protection")─────────►│→ encode     → bundle
```

### Signal Payloads

| Signal | Key Fields |
|--------|-----------|
| `liquidation` | `borrower`, `debtAsset`, `collateralAsset`, `maxDebtToRepay`, `healthFactor` |
| `arbitrage` | `tokenIn`, `tokenOut`, `amountIn`, `buyOnUniswap`, `uniswapFee`, `expectedProfitRaw` |
| `backrun` | `txHash`, `tokenIn`, `tokenOut`, `amountIn`, `valueEth` |
| `protection` | `user`, `debtAsset`, `repayAmount`, `currentHF` |

---

## Smart Contract: `AaveLiquidator.sol`

A unified on-chain router that handles all 4 strategies through a single `executeOperation` flash loan callback.

### Key Design Decisions

| Feature | Implementation |
|---------|---------------|
| **Flash loans** | Aave V3 `flashLoanSimple()` — borrows and repays atomically in one tx |
| **V3 swaps** | Uniswap V3 `exactInputSingle()` with configurable fee tier |
| **V2 swaps** | Sushiswap V2 `swapExactTokensForTokens()` |
| **Strategy routing** | ABI-encoded `strategyType` byte in flash loan `params` dispatches to the right handler |
| **Access control** | `onlyOwner` on all execution functions |
| **Reentrancy** | OpenZeppelin `ReentrancyGuard` on `withdraw` and `executeOperation` |
| **Circuit breaker** | `paused` state + `setPaused()` for emergency shutdown |
| **Gas optimization** | Max token approvals on deployment to avoid per-tx approve costs |

### Deployed

| Network | Address | Status |
|---------|---------|--------|
| **Sepolia** | `0x847335923C5D3d70791349E3b5d3Ed65739758c2` | ✅ Verified |

---

## Dashboard

A real-time web UI at `http://localhost:3000` showing:

- **Bot status** (online/offline, current block)
- **Wallet info** (balance, address)
- **Strategy stats** (liquidations, arbitrages, backruns — count + last execution details)
- **Live log feed** (scrolling output from the bundler)

The dashboard polls `/api/status` every 2 seconds. Built with vanilla HTML/CSS/JS (no framework).

---

## Testing

### 1. Smart Contract Tests (Foundry)

Located in `aave-flashbot-bot/test/AaveLiquidatortest.t.sol`. Uses mainnet forking to test against real Aave/Uniswap state.

```bash
cd aave-flashbot-bot
forge test --fork-url $ALCHEMY_RPC_URL -vvv
```

**13 test cases covering:**
- Owner access control on all 4 strategies
- Aave pool callback restriction (`onlyAavePool`)
- Flash loan round-trip mechanics
- Protection user registration/unregistration
- Fund deposit and withdrawal (ERC20 + ETH)
- Liquidation simulation (`simulateLiquidation()`)

### 2. Server Unit Tests

Located in `server/Tests/`. Simple Node.js scripts that test utility modules.

```bash
cd server
node Tests/healthFactorTest.js
node Tests/positionTrackerTest.js
```

**Covers:**
- Health factor parsing and formatting
- Best debt/collateral asset selection
- Position tracker FIFO logic with 300-position cap
- Case-insensitive address deduplication

### 3. Mainnet Fork Integration Test

Located in `flashbot-bundler/test/fork-test.js`. Tests every strategy's core logic against **real mainnet liquidity** using an Anvil fork.

```bash
# Terminal 1: Start the fork
anvil --fork-url $MAINNET_RPC_URL --port 8545

# Terminal 2: Run the tests
cd flashbot-bundler && node test/fork-test.js
```

**8 test groups, 14 assertions:**

| # | Test | What it validates |
|---|------|-------------------|
| 1 | Uniswap V3 Quote | `QuoterV2.quoteExactInputSingle()` returns real prices |
| 2 | Sushiswap V2 Quote | `Router.getAmountsOut()` returns real prices |
| 3 | Cross-DEX Spread | Detects the price difference between Uni V3 and Sushi V2 |
| 4 | Round-Trip Arb | Checks both Route A (Uni→Sushi) and Route B (Sushi→Uni) for profitability |
| 5 | Aave Position Query | `getUserAccountData()` returns valid collateral/debt/HF |
| 6 | Aave Oracle | `getAssetPrice()` returns reasonable USD prices |
| 7 | ABI Encoding | All 4 strategy functions encode without error (`executeLiquidation`, `executeArbitrage`, `executeBackrun`, `executeProtection`) |
| 8 | Multi-Fee-Tier | Quotes across all 4 Uni V3 fee tiers (0.01%, 0.05%, 0.3%, 1.0%) |

**Latest results (block 24,714,994):**

```
✅ 1 WETH = 2,058.60 USDC (Uniswap V3, 0.3% pool)
✅ 1 WETH = 2,026.07 USDC (Sushiswap V2)
✅ Cross-DEX spread: 1.61%
✅ Aave Oracle: WETH = $2,064.36, USDC = $1.00
✅ All ABI encodings valid
✅ 14 passed, 0 failed
```

### 4. Mock Mode Testing

Test the bundler pipeline without waiting for real blockchain events.

```bash
cd server

# Test liquidation pipeline
MOCK_MODE=true node index.js

# Test arbitrage pipeline
MOCK_ARB=true node index.js

# Test backrun pipeline
MOCK_BACKRUN=true node index.js

# Test all simultaneously
MOCK_MODE=true MOCK_ARB=true MOCK_BACKRUN=true node index.js
```

Mock mode emits hardcoded signals after a 2-second delay, exercising the full encode → simulate → send pipeline.

---

## Project Structure

```
shieldTxPrivate/
├── server/                         # Off-chain watcher
│   ├── index.js                    # Unified entry point
│   ├── src/
│   │   ├── watchers.js             # 4-strategy monitoring engine
│   │   ├── signalEmitter.js        # Shared EventEmitter bridge
│   │   ├── constants.js            # Sepolia addresses + ABIs
│   │   ├── healthFactor.js         # Aave HF math utilities
│   │   └── positionTracker.js      # FIFO address watchlist
│   ├── Tests/
│   │   ├── healthFactorTest.js
│   │   └── positionTrackerTest.js
│   ├── data/positions.json         # Seed positions (empty)
│   └── .env.example
│
├── flashbot-bundler/               # Bundle builder + dashboard
│   ├── src/
│   │   ├── bundler.js              # Core: signal → bundle → relay
│   │   ├── arbCalculator.js        # Cross-DEX arb scanner
│   │   ├── profitCalculator.js     # Liquidation profit math
│   │   └── dashboard.js            # Express API + static server
│   ├── public/
│   │   └── index.html              # Live dashboard UI
│   ├── test/
│   │   └── fork-test.js            # Mainnet fork integration test
│   └── .env
│
├── aave-flashbot-bot/              # Solidity contracts
│   ├── src/
│   │   ├── AaveLiquidator.sol      # Unified 4-strategy router
│   │   └── interfaces/             # Aave, Uniswap, Sushiswap ABIs
│   ├── script/
│   │   └── Deploy.s.sol            # Foundry deploy script
│   ├── test/
│   │   └── AaveLiquidatortest.t.sol # 13 fork-based unit tests
│   ├── config/
│   │   ├── abi.json                # Full contract ABI
│   │   └── networks.json           # Chain-specific addresses
│   └── foundry.toml
│
└── README.md                       # This document
```

---

## Running the Bot

### Prerequisites
- **Node.js** v18+
- **Foundry** (for contract tests)
- RPC endpoints (Sepolia WSS + HTTP)

### Quick Start

```bash
# 1. Install dependencies
cd server && npm install
cd ../flashbot-bundler && npm install

# 2. Configure environment
cp server/.env.example server/.env
# Edit .env with your Sepolia RPC URLs and keys

# 3. Run the full system
cd server && node index.js
# → Starts watcher + bundler + dashboard on port 3000

# 4. The Ultimate Hackathon Demo (Live Fork)
For the most visually impressive demonstration of the bot working against live Uniswap/Aave liquidity without risking real funds, please refer exclusively to:
👉 [HACKATHON_DEMO_EXPLAINER.md](./HACKATHON_DEMO_EXPLAINER.md)

# 5. (Alternative) Local Testing with Mock Signals
If you do not want to run an Anvil fork, you can test the dashboard by forcing hardcoded JSON signals into the bundler pipeline:
```bash
cd server && MOCK_MODE=true MOCK_ARB=true MOCK_BACKRUN=true node index.js
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `RPC_WSS` | Sepolia WebSocket URL for real-time block monitoring |
| `SEPOLIA_RPC_URL` | Sepolia HTTP URL for bundle building |
| `PRIVATE_KEY` | Owner wallet key (executes txs) |
| `FLASHBOTS_AUTH_KEY` | Relay signing key (not a money key) |
| `DASHBOARD_PORT` | Dashboard port (default: 3000) |
| `MOCK_MODE` | Emit fake liquidation signal on startup |
| `MOCK_ARB` | Emit fake arbitrage signal on startup |
| `MOCK_BACKRUN` | Emit fake backrun signal on startup |

---

## Security

| Measure | Where |
|---------|-------|
| **ReentrancyGuard** | `executeOperation()`, `withdraw()` |
| **onlyOwner** | All 4 execution functions |
| **Pause/Unpause** | `setPaused()` circuit breaker |
| **Flash loan verification** | `msg.sender == AAVE_POOL` check |
| **Private keys in .env** | Never committed to git (`.gitignore`) |
| **Flashbots relay** | Txs never enter public mempool |
