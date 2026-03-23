const state = {
    currentBlock: 0,
    positionsWatched: 0,
    bundlesSent: 0,
    bundlesLanded: 0,
    bundlesFailed: 0,
    lastLiquidation: null,
    lastArbitrage: null,
    lastBackrun: null,
    totalLiquidations: 0,
    totalArbitrages: 0,
    totalBackruns: 0,
    isRunning: false,
    logs: [],
};

function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    state.logs.push(entry);
    if (state.logs.length > 100) state.logs.shift();
}

module.exports = {
    state,
    log
};
