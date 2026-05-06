// ============================================================================
// Polymarket V11 Strategy Engine - REST API
// ============================================================================

import express, { Request, Response } from 'express';
import { StrategyEngine } from './engine';
import { StrategyConfig } from './config';
import { logger } from '../utils/logger';

export function createApi(engine: StrategyEngine, config: StrategyConfig) {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: '11.0.0', timestamp: Date.now() });
  });

  // Engine state
  app.get('/api/state', (_req: Request, res: Response) => {
    const state = engine.getState();
    res.json({
      running: state.running,
      mode: state.mode,
      totalPnl: state.totalPnl.toFixed(4),
      dailyPnl: state.dailyPnl.toFixed(4),
      positionsCount: state.positions.size,
      tradeCount: state.tradeHistory.length,
    });
  });

  // Get positions
  app.get('/api/positions', (_req: Request, res: Response) => {
    const positions = engine.getPositions();
    res.json(positions.map(p => ({
      conditionId: p.conditionId,
      outcome: p.outcome,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      size: p.size,
      pnl: p.pnl.toFixed(4),
      pnlPercent: p.pnlPercent.toFixed(2),
      market: p.market.question?.substring(0, 80),
    })));
  });

  // Get trade history
  app.get('/api/trades', (_req: Request, res: Response) => {
    const trades = engine.getTradeHistory();
    res.json(trades.map(t => ({
      id: t.id,
      conditionId: t.conditionId,
      side: t.side,
      outcome: t.outcome,
      price: t.price,
      size: t.size,
      ev: t.ev.toFixed(2),
      pnl: t.pnl.toFixed(4),
      reason: t.reason,
      timestamp: new Date(t.timestamp).toISOString(),
    })));
  });

  // Start engine
  app.post('/api/start', async (req: Request, res: Response) => {
    const { mode } = req.body;
    try {
      await engine.start(mode || 'scan');
      res.json({ success: true, mode: mode || 'scan' });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Stop engine
  app.post('/api/stop', (_req: Request, res: Response) => {
    engine.stop();
    res.json({ success: true });
  });

  // Scan markets
  app.post('/api/scan', async (_req: Request, res: Response) => {
    try {
      const results = await engine.scanMarkets();
      res.json({
        total: results.length,
        passed: results.filter(r => r.pass).length,
        results: results.slice(0, 20).map(r => ({
          question: r.market.question?.substring(0, 80),
          ev: r.ev.toFixed(4),
          spread: r.spread.toFixed(2),
          liquidity: r.liquidity.toFixed(0),
          pass: r.pass,
          rejectReason: r.rejectReason,
        })),
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Config info
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      strategy: 'V11',
      parameters: {
        minEvPercent: config.minEvPercent,
        maxYesPrice: config.maxYesPrice,
        takeProfitPercent: config.takeProfitPercent,
        stopLossPercent: config.stopLossPercent,
        kellyFraction: config.kellyFraction,
        maxPositionPercent: config.maxPositionPercent,
        minLiquidityUsd: config.minLiquidityUsd,
        maxSpreadPercent: config.maxSpreadPercent,
        manipulationVolatilityThreshold: config.manipulationVolatilityThreshold,
        maxTradesPerHour: config.maxTradesPerHour,
        maxDailyLossUsd: config.maxDailyLossUsd,
      },
      wallets: {
        trading: config.tradingWallet,
        profitRecovery: config.profitRecoveryWallet,
      },
    });
  });

  return app;
}
