// ============================================================================
// Polymarket V11 Strategy Engine - Main Entry Point
// ============================================================================

import { config } from './core/config';
import { StrategyEngine } from './core/engine';
import { createApi } from './api/server';
import { logger } from './utils/logger';

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
  let mode: 'scan' | 'trade' | 'monitor' = 'scan';

  for (const arg of args) {
    if (arg === '--mode' || arg.startsWith('--mode=')) {
      const modeVal = arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];
      if (['scan', 'trade', 'monitor'].includes(modeVal)) {
        mode = modeVal as 'scan' | 'trade' | 'monitor';
      }
    }
  }

  logger.info('Configuration loaded', {
    tradingWallet: config.tradingWallet,
    minEV: config.minEvPercent + '%',
    maxYesPrice: config.maxYesPrice,
    takeProfit: config.takeProfitPercent + '%',
    stopLoss: config.stopLossPercent + '%',
    kellyFraction: config.kellyFraction,
    maxPosition: config.maxPositionPercent + '%',
    minLiquidity: '$' + config.minLiquidityUsd,
    maxSpread: config.maxSpreadPercent + '%',
    manipulationThreshold: config.manipulationVolatilityThreshold + '%',
    maxTradesPerHour: config.maxTradesPerHour,
    maxDailyLoss: '$' + config.maxDailyLossUsd,
  });

  // Initialize engine
  const engine = new StrategyEngine(config);

  // Start API server
  const app = createApi(engine, config);
  const port = config.port;

  app.listen(port, () => {
    logger.info(`API server running on port ${port}`);
    logger.info(`Health check: http://localhost:${port}/health`);
    logger.info(`API endpoints: http://localhost:${port}/api/`);
  });

  // Start engine
  try {
    await engine.start(mode);
    logger.info(`Engine started in ${mode} mode`);
  } catch (error: any) {
    logger.error('Failed to start engine', { error: error.message });
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
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
