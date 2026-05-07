// ============================================================================
// Polymarket V13 Strategy Engine - Main Entry Point
// ============================================================================
// BTC 5MIN Scalper + V11 Strategy + Marketing101 Module + Visual Dashboard

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import * as path from 'path';
import { StrategyConfig, loadConfig } from './core/config';
import { ScalperEngine } from './core/scalper';
import { Marketing101Engine } from './core/marketing101-engine';
import { BinanceFeed } from './feeds/binance-ws';
import { PolymarketClient } from './services/polymarket-client';
import { TradeStore } from './storage/trade-store';
import { logger } from './utils/logger';

dotenv.config();

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║         Polymarket V13 - BTC Scalper + Marketing101             ║
║                                                                   ║
║  Module 1: BTC 5MIN Scalper (CLOB Price Lag Exploitation)       ║
║  - Binance WS → BTC Realtime + 5M Klines                        ║
║  - Signal Convergence > 70% → Trade                              ║
║  - Lag > 0.3% → Execute < 5s                                     ║
║  - TP 0.8% | SL 0.3% | Daily Cap 2% | Hard Stop -0.4%          ║
║                                                                   ║
║  Module 2: Marketing101 Engine (AI + MiroFish 10K Sim)           ║
║  - Claude Brain + MiroFish Monte Carlo (10K loops)               ║
║  - BTC Price Simulator (Jump-Diffusion + Mean Reversion)         ║
║  - OTC Desk Flow Data + Closed Order Book Analysis               ║
║  - 5-Source Convergence: 4/5 must agree to trade                 ║
║  - Position: $2-$10 (paper 50U) | Target: $5K-$15K (live)         ║
║                                                                   ║
║  Paper Mode by default | Live when API keys set                   ║
╚══════════════════════════════════════════════════════════════════╝
`;

const config: StrategyConfig = loadConfig();
const PORT = config.port;

// Core components
let scalper: ScalperEngine | null = null;
let marketing101: Marketing101Engine | null = null;
let binance: BinanceFeed | null = null;
let client: PolymarketClient | null = null;
let store: TradeStore | null = null;

async function main() {
  console.log(BANNER);

  const app = express();
  app.use(express.json());

  // Serve dashboard static files
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- API Routes ----

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '13.1.0',
      engine: scalper?.isRunning() ? 'running' : 'idle',
      marketing101: marketing101?.isRunning() ? 'running' : 'idle',
      mode: scalper?.getMode() || 'idle',
      binance: binance?.isConnected() || false,
      timestamp: Date.now(),
    });
  });

  // Full engine state (for dashboard)
  app.get('/api/state', (_req: Request, res: Response) => {
    try {
      if (!scalper) {
        return res.json({
          running: false,
          mode: 'idle',
          btcPrice: 0,
          btcPrice5mAgo: 0,
          btcPriceChange5m: 0,
          activeConvergence: null,
          positions: [],
          trades: [],
          totalPnl: 0,
          dailyPnl: 0,
          winRate: 0,
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          signals: [],
          lastSignalTime: 0,
          scanCount: 0,
          tradeCount: 0,
          skipCount: 0,
          startTime: 0,
          dailyCapUsed: 0,
          dailyCapLimit: config.dailyCapPercent,
          hardStopTriggered: false,
          klines5m: [],
          btcVolume5m: 0,
          binanceConnected: false,
          polymarketConnected: false,
          lastError: null,
          lastSimulation: null,
          simulationCount: 0,
          calibrationAccuracy: 0,
          // Marketing101 state
          m101: null,
        });
      }
      const scalperState = scalper.getState();
      const m101State = marketing101?.getState() || null;

      res.json({
        ...scalperState,
        m101: m101State,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Marketing101 specific state
  app.get('/api/m101', (_req: Request, res: Response) => {
    try {
      if (!marketing101) {
        return res.json({ running: false, message: 'Marketing101 engine not initialized' });
      }
      res.json(marketing101.getState());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Marketing101 signals
  app.get('/api/m101/signals', (_req: Request, res: Response) => {
    try {
      const state = marketing101?.getState();
      res.json({
        signals: state?.lastSignals || [],
        decision: state?.lastDecision || null,
        otcSnapshot: state?.lastOtcSnapshot || null,
        closedBook: state?.lastClosedBook || null,
        btcSim: state?.lastBtcSim || null,
        simResult: state?.lastSimResult || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get all trades
  app.get('/api/trades', (_req: Request, res: Response) => {
    try {
      const trades = store?.getTrades() || [];
      res.json(trades);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get open positions
  app.get('/api/positions', (_req: Request, res: Response) => {
    try {
      const positions = store?.getOpenPositions() || [];
      res.json(positions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get closed positions
  app.get('/api/positions/closed', (_req: Request, res: Response) => {
    try {
      const trades = store?.getTrades() || [];
      const closedTrades = trades.filter(t => t.status === 'closed' && t.side === 'SELL');
      res.json(closedTrades);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get signals
  app.get('/api/signals', (_req: Request, res: Response) => {
    try {
      const state = scalper?.getState();
      res.json({
        signals: state?.signals || [],
        convergence: state?.activeConvergence || null,
        lastSignalTime: state?.lastSignalTime || 0,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get config
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      version: 'V13.1',
      scalper: {
        enabled: config.scalperEnabled,
        mode: config.scalperMode,
        lagThreshold: config.lagThreshold + '%',
        perTradeRisk: config.perTradeRiskPercent + '%',
        dailyCap: config.dailyCapPercent + '%',
        hardStop: config.hardStopPercent + '%',
        minConvergence: config.minConvergence + '%',
        maxActivePositions: config.maxActivePositions,
        takeProfitScalp: config.takeProfitScalp + '%',
        stopLossScalp: config.stopLossScalp + '%',
      },
      marketing101: {
        enabled: true,
        mode: 'paper',
        sources: ['claude_brain', 'mirofish', 'btc_sim', 'otc', 'closed_book'],
        consensusRequired: '4/5 (80%)',
        simulationLoops: 10000,
        positionSize: '$2-$10 (paper 50U) | $5K-$15K (live)',
      },
      wallets: {
        trading: config.tradingWallet,
        profitRecovery: config.profitRecoveryWallet,
      },
      binance: {
        ws: config.binanceWsUrl ? 'configured' : 'default',
        rest: config.binanceRestUrl ? 'configured' : 'default',
      },
      polymarket: {
        apiUrl: config.polymarketApiUrl,
        apiKeySet: !!config.polymarketApiKey,
      },
    });
  });

  // Start scalper
  app.post('/api/start', async (req: Request, res: Response) => {
    try {
      const mode = req.body.mode || config.scalperMode;

      if (scalper?.isRunning()) {
        return res.json({ success: false, error: 'Engine already running' });
      }

      // Initialize components if needed
      if (!binance) binance = new BinanceFeed(config);
      if (!client) client = new PolymarketClient(config);
      if (!store) store = new TradeStore();

      scalper = new ScalperEngine(config, binance, client, store);

      // Override mode if specified
      if (mode === 'live' && !config.polymarketApiKey) {
        logger.warn('No API key set, falling back to paper mode');
      }

      await scalper.start();

      // Start Marketing101 engine
      if (!marketing101) {
        marketing101 = new Marketing101Engine(config);
      }
      const btcPrice = binance.getPrice() || 80000;
      await marketing101.start(btcPrice);

      res.json({ success: true, mode: scalper.getMode(), m101: marketing101.isRunning() });
    } catch (e: any) {
      logger.error('Failed to start scalper', { error: e.message });
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Stop scalper
  app.post('/api/stop', (_req: Request, res: Response) => {
    try {
      if (scalper) {
        scalper.stop();
        scalper = null;
      }
      if (marketing101) {
        marketing101.stop();
      }
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Export all data
  app.get('/api/export', (_req: Request, res: Response) => {
    try {
      const data = store?.exportAll() || { trades: [], positions: [], stats: {} };
      const m101State = marketing101?.getState() || null;
      res.setHeader('Content-Disposition', 'attachment; filename=polymarket-export.json');
      res.json({ ...data, marketing101: m101State });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dashboard route
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  });

  // ---- Start Server ----

  app.listen(PORT, () => {
    console.log(`[V13 Scalper] API server running on port ${PORT}`);
    console.log(`[V13 Scalper] Dashboard: http://localhost:${PORT}/`);
    console.log(`[V13 Scalper] API: http://localhost:${PORT}/api/`);
    console.log(`[V13 Scalper] M101 API: http://localhost:${PORT}/api/m101/`);
    console.log(`[V13 Scalper] Mode: ${config.scalperMode}${config.dryRun ? ' (DRY RUN)' : ''}`);
  });

  // Auto-start scalper if enabled
  if (config.scalperEnabled) {
    setTimeout(async () => {
      try {
        console.log('[V13 Scalper] Auto-starting scalper engine...');
        binance = new BinanceFeed(config);
        client = new PolymarketClient(config);
        store = new TradeStore();
        scalper = new ScalperEngine(config, binance, client, store);
        await scalper.start();

        // Start Marketing101 engine
        marketing101 = new Marketing101Engine(config);
        const btcPrice = binance.getPrice() || 80000;
        await marketing101.start(btcPrice);

        console.log('[V13 Scalper] Engine started successfully (Scalper + Marketing101)');
      } catch (e: any) {
        console.error('[V13 Scalper] Auto-start failed:', e.message);
        console.log('[V13 Scalper] Use POST /api/start to start manually');
      }
    }, 3000);
  }

  // Update Marketing101 with BTC price from Binance feed
  setInterval(() => {
    if (binance && marketing101 && scalper?.isRunning()) {
      const price = binance.getPrice();
      if (price > 0) {
        marketing101.updateBtcPrice(price, []);
      }
    }
  }, 5000);

  // Graceful shutdown
  const shutdown = () => {
    console.log('[V13 Scalper] Shutting down...');
    if (scalper) scalper.stop();
    if (marketing101) marketing101.stop();
    if (store) store.save();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
