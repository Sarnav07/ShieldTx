const { ethers } = require("ethers");
require("dotenv").config({ path: "./server/.env" });
async function run() {
    const provider = new ethers.providers.JsonRpcProvider("http://127.0.0.1:8546");
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const contractAddy = require("./.demo-contract.json").contractAddress;
    
    const abi = ["function executeArbitrage(address,address,uint256,bool,uint24,uint256)"];
    const contract = new ethers.Contract(contractAddy, abi, wallet);
    
    console.log("Simulating...");
    try {
        await contract.callStatic.executeArbitrage(
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            ethers.utils.parseEther("0.1"),
            true,
            3000,
            0
        );
        console.log("Success");
    } catch(e) {
        console.log("Revert:", e.message);
        if (e.error) console.log(e.error);
    }
}
run();
