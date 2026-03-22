# The Ultimate Hackathon Demo: How It Works under the Hood

This document explains the technical architecture of the live network demo. It is designed to help you confidently answer questions from judges about what is "real" and what is "simulated" in your presentation.

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

## 4. Summary for Judges

If asked, you can confidently explain the limits of the simulation:

**WHAT IS 100% REAL:**
* **The On-Chain Math:** Your Node.js backend queries real Uniswap quoting contracts to determine profitability.
* **The Architecture:** The event-driven Watcher -> Emitter -> Bundler Node.js pipeline is exactly how production MEV bots are structured.
* **The Solidity Execution:** The `AaveLiquidator.sol` contract genuinely executes the multi-leg flash-loan arbitrage on the local fork, paying simulated gas and updating its internal ETH balance.
* **The Dashboard:** The UI updates are driven by genuine backend events, not hardcoded strings.

**WHAT IS "FAKED" OR MODIFIED FOR THE DEMO:**
* **The Opportunity:** You forced the market imbalance by dumping 200 fake ETH via a script, rather than waiting weeks for a real person to make a mistake on-chain.
* **The Flashbots Relay:** The bundle is constructed perfectly, but it is routed out to the local blockchain via standard RPC instead of the Flashbots Private Mempool Network so that the demonstration can execute locally.
