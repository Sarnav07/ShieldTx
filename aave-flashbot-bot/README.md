aave-flashbot-bot/
  src/               ← Solidity (Foundry)
  test/              ← Solidity tests
  script/            ← Solidity deploy scripts
  lib/               ← Solidity deps
  config/
    abi.json         ← THE shared file
  offchain/          ← Node.js root for Person B and C
    package.json
    src/
      watcher.js
      bundler.js
      healthFactor.js
  foundry.toml
  .env.example



## First time setup (everyone)
git clone <repo>
cd aave-flashbot-bot
forge install               # installs Solidity deps
cp .env.example .env        # fill in your keys
forge build                 # compile contracts

## Person A — contract work
forge test --fork-url $ALCHEMY_RPC_URL -vvv

## Start local node (Person A runs this, leave it open)
anvil --fork-url $ALCHEMY_RPC_URL --fork-block-number 19500000

## Deploy to local fork
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast

## Person B — watcher
cd offchain && npm install && node src/watcher.js

## Person C — bundler
cd offchain && npm install && node src/bundler.js