.PHONY: help install start demo watch format lint clean

help:
	@echo "Usage:"
	@echo "  make install      Install Node.js dependencies"
	@echo "  make start        Run the live server and watcher in production mode"
	@echo "  make demo         Run the server with mock MEV signals for the hackathon"
	@echo "  make watch        Run the server with nodemon for live development reloading"
	@echo "  make lint         Run eslint check"
	@echo "  make format       Format code with prettier"

install:
	@echo "Installing server dependencies..."
	npm install
	@echo "Installing linked bundler dependencies..."
	cd ../flashbot-bundler && npm install

start:
	node index.js

demo:
	MOCK_MODE=true MOCK_ARB=true node index.js

watch:
	npx nodemon index.js

lint:
	npx eslint src/

format:
	npx prettier --write "src/**/*.js"

clean:
	rm -rf node_modules package-lock.json
