const tracker = require("../src/positionTracker");

const all = tracker.getAll();
for (let key of all.keys()) {
    tracker.removePosition(key);
}

// ── Test addPosition ──
console.log("Adding positions...");
tracker.addPosition("0xABC");
tracker.addPosition("0xDEF");
tracker.addPosition("0xabc"); // duplicate (case-insensitive)

console.log("Size (should be 2):", tracker.getSize());

// ── Test removePosition ──
console.log("\nRemoving position 0xabc...");
tracker.removePosition("0xabc");
console.log("Size (should be 1):", tracker.getSize());

// ── Test pending logic ──
console.log("\nTesting pending...");
tracker.markPending("0x123");
console.log("Is pending (true):", tracker.isPending("0x123"));

tracker.clearPending("0x123");
console.log("Is pending (false):", tracker.isPending("0x123"));

// ── Test FIFO logic ──
console.log("\nTesting FIFO...");
for (let i = 0; i < 305; i++) {
    tracker.addPosition("0x" + i);
}
console.log("Size (should be 300):", tracker.getSize());

// ── Inspect data ──
console.log("\nFinal watchlist sample:");
console.log([...tracker.getAll().keys()].slice(0, 5));
