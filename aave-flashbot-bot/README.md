# ShieldTx — MEV Liquidation Bot (Aave V3 + Flashbots)

## Architecture
```
aave-flashbot-bot/
  src/               ← Solidity contracts (Foundry)
  test/              ← Solidity tests
  script/            ← Deploy + simulation scripts
  lib/               ← Solidity dependencies
  config/
    abi.json         ← Shared ABI for Person C
    networks.json    ← Chain addresses for all teammates
    candidates.json  ← Addresses to monitor (Person B populates)
  offchain/          ← Node.js (Person B + C)
    src/
      watcher.js     ← Health factor monitoring
      bundler.js     ← Flashbots bundle submission
      healthFactor.js
  foundry.toml
  .env.example
```

## Setup
```bash
git clone <repo>
cd aave-flashbot-bot
forge install
cp .env.example .env     # fill in your keys
forge build
```

## Person A — Contract Work
```bash
forge test --fork-url $ALCHEMY_RPC_URL -vvv
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
```

## Person B — Watcher
```bash
cd offchain && npm install && node src/watcher.js
```

## Person C — Bundler
```bash
cd offchain && npm install && node src/bundler.js
```

## Deployed Contracts

| Network | Address | Verified |
|---------|---------|----------|
| Sepolia | `0x2b368CFBe2dB3B112D167648ABa6526509dE144F` | ✅ |

## Strategies
1. **Liquidation** — Flash loan → liquidate underwater user → swap collateral → profit
2. **Arbitrage** — Flash loan → Uniswap V3 ↔ Sushiswap V2 → profit from spread
3. **Backrun** — Same as arb, bundled after a target tx via Flashbots
4. **Protection** — Flash loan → repay user's debt → save from liquidation