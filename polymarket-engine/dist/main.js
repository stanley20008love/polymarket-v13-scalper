"use strict";
// ============================================================================
// Polymarket V11 Strategy Engine - Main Entry Point
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./core/config");
const engine_1 = require("./core/engine");
const server_1 = require("./api/server");
const logger_1 = require("./utils/logger");
const BANNER = `
╔══════════════════════════════════════════════════════════╗
║           Polymarket V11 Strategy Engine                 ║
║                                                          ║
║  EV>5% | Yes<0.2 Skip | TP40% SL15% | Half-Kelly 10%  ║
║  Liquidity>$10k | Spread<5% | Anti-Manipulation 20%    ║
║  2 trades/hour | $2 daily loss limit                     ║
╚══════════════════════════════════════════════════════════╝
`;
async function main() {
    console.log(BANNER);
    // Determine mode from CLI args
    const args = process.argv.slice(2);
    let mode = 'scan';
    for (const arg of args) {
        if (arg === '--mode' || arg.startsWith('--mode=')) {
            const modeVal = arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];
            if (['scan', 'trade', 'monitor'].includes(modeVal)) {
                mode = modeVal;
            }
        }
    }
    logger_1.logger.info('Configuration loaded', {
        tradingWallet: config_1.config.tradingWallet,
        minEV: config_1.config.minEvPercent + '%',
        maxYesPrice: config_1.config.maxYesPrice,
        takeProfit: config_1.config.takeProfitPercent + '%',
        stopLoss: config_1.config.stopLossPercent + '%',
        kellyFraction: config_1.config.kellyFraction,
        maxPosition: config_1.config.maxPositionPercent + '%',
        minLiquidity: '$' + config_1.config.minLiquidityUsd,
        maxSpread: config_1.config.maxSpreadPercent + '%',
        manipulationThreshold: config_1.config.manipulationVolatilityThreshold + '%',
        maxTradesPerHour: config_1.config.maxTradesPerHour,
        maxDailyLoss: '$' + config_1.config.maxDailyLossUsd,
    });
    // Initialize engine
    const engine = new engine_1.StrategyEngine(config_1.config);
    // Start API server
    const app = (0, server_1.createApi)(engine, config_1.config);
    const port = config_1.config.port;
    app.listen(port, () => {
        logger_1.logger.info(`API server running on port ${port}`);
        logger_1.logger.info(`Health check: http://localhost:${port}/health`);
        logger_1.logger.info(`API endpoints: http://localhost:${port}/api/`);
    });
    // Start engine
    try {
        await engine.start(mode);
        logger_1.logger.info(`Engine started in ${mode} mode`);
    }
    catch (error) {
        logger_1.logger.error('Failed to start engine', { error: error.message });
        process.exit(1);
    }
    // Graceful shutdown
    const shutdown = () => {
        logger_1.logger.info('Shutting down...');
        engine.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
