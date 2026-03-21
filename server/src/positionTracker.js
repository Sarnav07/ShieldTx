//Manages the address it will check every block

const fs = require("fs");
const path = require("path");
const watchList = new Map();//main watchlist(address to metadata)
const pending = new Set();


function seedFromFile() {
    const filePath = path.join(__dirname, "../data/positions.json");
    if (!fs.existsSync(filePath)) {
        console.log("[tracker] No positions.json found — starting empty");
        return;
    }
    const addresses = JSON.parse(fs.readFileSync(filePath, "utf8"));
    addresses.forEach(addr => watchList.set(addr.toLowerCase(), {}));
    console.log(`[tracker] Seeded ${watchList.size} positions from file`);
}

const MAX_POSITIONS = 300;
function addPosition(address) {
    const addr = address.toLowerCase();
    if (watchList.has(addr)) return;
    if (watchList.size >= MAX_POSITIONS) {
        const first = watchList.keys().next().value;
        watchList.delete(first);//will work on first in first out principle
    }
    watchList.set(addr, {});
}


function removePosition(address) {
    watchList.delete(address.toLowerCase());
}
function markPending(address) { pending.add(address.toLowerCase()); }
function clearPending(address) { pending.delete(address.toLowerCase()); }
function isPending(address) { return pending.has(address.toLowerCase()); }

//Getters
function getAll() { return watchList; }
function getSize() { return watchList.size; }

seedFromFile();

module.exports = {
    addPosition, removePosition,
    markPending, clearPending, isPending,
    getAll, getSize
};