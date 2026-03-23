-include .env

.PHONY: all test clean deploy simulate help install snapshot format anvil 

DEFAULT_ANVIL_KEY := 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

help:
	@echo "Usage:"
	@echo "  make deploy [ARGS=...]\n    example: make deploy ARGS=\"--network sepolia\""
	@echo ""
	@echo "  make simulate\n    Runs the off-chain profitability simulator script"

all: clean install build

# Clean the repo
clean  :; forge clean

# Install dependencies
install :; forge install foundry-rs/forge-std aave/aave-v3-core OpenZeppelin/openzeppelin-contracts

# Update Dependencies
update:; forge update

build:; forge build

# Run tests with mainnet fork
test :; forge test --fork-url $${ALCHEMY_RPC_URL} -vvv

coverage :; forge coverage --report debug > coverage-report.txt

snapshot :; forge snapshot --fork-url $${ALCHEMY_RPC_URL}

format :; forge fmt

anvil :; anvil -m 'test test test test test test test test test test test junk' --steps-tracing --block-time 1

NETWORK_ARGS := --rpc-url http://localhost:8545 --private-key $(DEFAULT_ANVIL_KEY) --broadcast

ifeq ($(findstring --network sepolia,$(ARGS)),--network sepolia)
	NETWORK_ARGS := --rpc-url $(SEPOLIA_RPC_URL) --private-key $(PRIVATE_KEY) --broadcast --verify --etherscan-api-key $(ETHERSCAN_API_KEY) -vvvv
endif

deploy:
	@forge script script/Deploy.s.sol:Deploy $(NETWORK_ARGS)

simulate:
	@forge script script/Simulator.s.sol:Simulator --rpc-url $(SEPOLIA_RPC_URL) -vvvv
