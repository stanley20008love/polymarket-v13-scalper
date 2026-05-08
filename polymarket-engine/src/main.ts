// ============================================================================
// Polymarket V16 - 五引擎50U模拟盘
// ============================================================================
// 5策略独立运行，各50U模拟盘:
// 1. BTC 5分钟剥头皮 (ScalperEngine)
// 2. Marketing101 5源信号 (Marketing101Engine)
// 3. 跟单交易 (CopyTradingEngine)
// 4. 债券策略 (BondEngine)
// 5. Kelly均值回归 (KellyEngine)

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import * as path from 'path';
import { StrategyConfig, loadConfig } from './core/config';
import { ScalperEngine } from './core/scalper';
import { Marketing101Engine } from './core/marketing101-engine';
import { CopyTradingEngine } from './core/copy-trading-engine';
import { BondEngine } from './core/bond-engine';
import { KellyEngine } from './core/kelly-engine';
import { BinanceFeed } from './feeds/binance-ws';
import { PolymarketClient } from './services/polymarket-client';
import { TradeStore } from './storage/trade-store';
import { logger } from './utils/logger';

dotenv.config();

const VERSION = '16.0.0';

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║         Polymarket V16 - 五引擎50U模拟盘                         ║
║                                                                   ║
║  策略1: ⚡ BTC 5分钟剥头皮 (CLOB价格滞后套利)                    ║
║  策略2: 🧠 Marketing101 (5源信号: Claude+MiroFish+BTC+OTC+订单簿)║
║  策略3: 📋 跟单交易 (>90%胜率钱包自动跟单)                       ║
║  策略4: 🏦 债券策略 (>90%概率市场稳健收益)                       ║
║  策略5: 🎯 Kelly均值回归 (EMA12+1/4Kelly+5源融合)                ║
║                                                                   ║
║  各策略独立50U模拟盘 | 日PnL自动重置 | 余额保护                   ║
╚══════════════════════════════════════════════════════════════════╝
`;

const config: StrategyConfig = loadConfig();
const PORT = config.port;

// 核心组件
let scalper: ScalperEngine | null = null;
let marketing101: Marketing101Engine | null = null;
let copyTrading: CopyTradingEngine | null = null;
let bondEngine: BondEngine | null = null;
let kellyEngine: KellyEngine | null = null;
let binance: BinanceFeed | null = null;
let client: PolymarketClient | null = null;
let store: TradeStore | null = null;

async function main() {
  console.log(BANNER);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- Health Check ----
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: VERSION,
      engines: {
        scalper: scalper?.isRunning() ? 'running' : 'idle',
        marketing101: marketing101?.isRunning() ? 'running' : 'idle',
        copyTrading: copyTrading?.isRunning() ? 'running' : 'idle',
        bond: bondEngine?.isRunning() ? 'running' : 'idle',
        kelly: kellyEngine?.isRunning() ? 'running' : 'idle',
      },
      binance: binance?.isConnected() || false,
      timestamp: Date.now(),
    });
  });

  // ---- Engine State (for Dashboard) ----
  app.get('/api/state', (_req: Request, res: Response) => {
    try {
      res.json({
        version: VERSION,
        running: scalper?.isRunning() || marketing101?.isRunning() || copyTrading?.isRunning() || bondEngine?.isRunning() || kellyEngine?.isRunning() || false,
        scalper: scalper?.getState() || null,
        marketing101: marketing101?.getState() || null,
        copyTrading: copyTrading?.getState() || null,
        bond: bondEngine?.getState() || null,
        kelly: kellyEngine?.getState() || null,
        binance: {
          connected: binance?.isConnected() || false,
          btcPrice: binance?.getPrice() || 0,
          btcChange5m: binance?.getChange5m() || 0,
          btcVolume5m: binance?.getVolume5m() || 0,
        },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Per-Engine API Endpoints ----

  // Scalper
  app.get('/api/scalper', (_req: Request, res: Response) => {
    res.json(scalper?.getState() || { running: false });
  });

  // Marketing101
  app.get('/api/m101', (_req: Request, res: Response) => {
    res.json(marketing101?.getState() || { running: false });
  });

  app.get('/api/m101/signals', (_req: Request, res: Response) => {
    const state = marketing101?.getState();
    res.json({
      signals: state?.lastSignals || [],
      decision: state?.lastDecision || null,
      otcSnapshot: state?.lastOtcSnapshot || null,
      closedBook: state?.lastClosedBook || null,
      btcSim: state?.lastBtcSim || null,
    });
  });

  app.get('/api/m101/trades', (_req: Request, res: Response) => {
    res.json({
      open: marketing101?.getOpenPositions() || [],
      closed: marketing101?.getClosedTrades() || [],
    });
  });

  // Copy Trading
  app.get('/api/copy', (_req: Request, res: Response) => {
    res.json(copyTrading?.getState() || { running: false });
  });

  app.get('/api/copy/trades', (_req: Request, res: Response) => {
    res.json({
      open: copyTrading?.getOpenPositions() || [],
      closed: copyTrading?.getClosedTrades() || [],
    });
  });

  // Bond
  app.get('/api/bond', (_req: Request, res: Response) => {
    res.json(bondEngine?.getState() || { running: false });
  });

  app.get('/api/bond/trades', (_req: Request, res: Response) => {
    res.json({
      open: bondEngine?.getOpenPositions() || [],
      closed: bondEngine?.getClosedTrades() || [],
    });
  });

  // Kelly
  app.get('/api/kelly', (_req: Request, res: Response) => {
    res.json(kellyEngine?.getState() || { running: false });
  });

  app.get('/api/kelly/trades', (_req: Request, res: Response) => {
    res.json({
      open: kellyEngine?.getOpenPositions() || [],
      closed: kellyEngine?.getClosedTrades() || [],
    });
  });

  // ---- Shared API ----
  app.get('/api/trades', (_req: Request, res: Response) => {
    res.json(store?.getTrades() || []);
  });

  app.get('/api/positions', (_req: Request, res: Response) => {
    res.json(store?.getOpenPositions() || []);
  });

  app.get('/api/export', (_req: Request, res: Response) => {
    try {
      const data = store?.exportAll() || { trades: [], positions: [], stats: {} };
      res.setHeader('Content-Disposition', `attachment; filename=polymarket-v${VERSION}-export.json`);
      res.json({
        ...data,
        marketing101: marketing101?.getState() || null,
        copyTrading: copyTrading?.getState() || null,
        bond: bondEngine?.getState() || null,
        kelly: kellyEngine?.getState() || null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      版本: `V${VERSION}`,
      模式: '模拟盘 (5策略独立50U)',
      策略: {
        剥头皮: { 启用: true, 滞后阈值: config.lagThreshold + '%', 止盈: config.takeProfitScalp + '%', 止损: config.stopLossScalp + '%' },
        Marketing101: { 启用: true, 信号源: ['Claude', 'MiroFish', 'BTC模拟', 'OTC', '订单簿'], 共识: '3/5 (60%)' },
        跟单: { 启用: true, 最低胜率: '90%', 最低盈利: '$100K' },
        债券: { 启用: true, 最低概率: '90%', 最低年化: '15%' },
        Kelly: { 启用: true, Kelly比例: '1/4', EMA周期: 12, 偏离阈值: '5%' },
      },
    });
  });

  // ---- Start/Stop ----
  app.post('/api/start', async (req: Request, res: Response) => {
    try {
      if (scalper?.isRunning()) {
        return res.json({ success: false, error: '引擎已在运行' });
      }

      // Initialize shared components
      if (!binance) binance = new BinanceFeed(config);
      if (!client) client = new PolymarketClient(config);
      if (!store) store = new TradeStore();

      // 1. Scalper Engine
      scalper = new ScalperEngine(config, binance, client, store);
      await scalper.start();

      // 2. Marketing101 Engine
      if (!marketing101) marketing101 = new Marketing101Engine(config);
      const btcPrice = binance.getPrice() || 80000;
      await marketing101.start(btcPrice);

      // 3. Copy Trading Engine
      if (!copyTrading) copyTrading = new CopyTradingEngine(config);
      await copyTrading.start();

      // 4. Bond Engine
      if (!bondEngine) bondEngine = new BondEngine(config);
      await bondEngine.start();

      // 5. Kelly Engine
      if (!kellyEngine) kellyEngine = new KellyEngine(config);
      await kellyEngine.start(btcPrice);

      res.json({
        success: true,
        engines: {
          scalper: scalper.getMode(),
          marketing101: marketing101.isRunning() ? '运行中' : '空闲',
          copyTrading: copyTrading.isRunning() ? '运行中' : '空闲',
          bond: bondEngine.isRunning() ? '运行中' : '空闲',
          kelly: kellyEngine.isRunning() ? '运行中' : '空闲',
        },
      });
    } catch (e: any) {
      logger.error('启动引擎失败', { error: e.message });
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/stop', (_req: Request, res: Response) => {
    try {
      if (scalper) { scalper.stop(); scalper = null; }
      if (marketing101) { marketing101.stop(); }
      if (copyTrading) { copyTrading.stop(); }
      if (bondEngine) { bondEngine.stop(); }
      if (kellyEngine) { kellyEngine.stop(); }
      res.json({ success: true, 消息: '五引擎已停止' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Dashboard route
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  });

  // ---- Start Server ----
  app.listen(PORT, () => {
    console.log(`[V${VERSION}] API服务器运行于端口 ${PORT}`);
    console.log(`[V${VERSION}] 面板: http://localhost:${PORT}/`);
  });

  // Auto-start
  if (config.scalperEnabled) {
    setTimeout(async () => {
      try {
        console.log('[V16] 自动启动五引擎...');

        binance = new BinanceFeed(config);
        client = new PolymarketClient(config);
        store = new TradeStore();

        // 1. Scalper
        scalper = new ScalperEngine(config, binance, client, store);
        await scalper.start();

        const btcPrice = binance.getPrice() || 80000;

        // 2. Marketing101
        marketing101 = new Marketing101Engine(config);
        await marketing101.start(btcPrice);

        // 3. Copy Trading
        copyTrading = new CopyTradingEngine(config);
        await copyTrading.start();

        // 4. Bond
        bondEngine = new BondEngine(config);
        await bondEngine.start();

        // 5. Kelly
        kellyEngine = new KellyEngine(config);
        await kellyEngine.start(btcPrice);

        console.log('[V16] 五引擎启动成功 (5×50U模拟盘)');
      } catch (e: any) {
        console.error('[V16] 自动启动失败:', e.message);
        console.log('[V16] 请使用 POST /api/start 手动启动');
      }
    }, 3000);
  }

  // Update BTC price for all engines
  setInterval(() => {
    if (!binance) return;
    const price = binance.getPrice();
    if (price <= 0) return;

    if (marketing101 && marketing101.isRunning()) {
      marketing101.updateBtcPrice(price, []);
    }
    if (kellyEngine && kellyEngine.isRunning()) {
      kellyEngine.updateBtcPrice(price);
    }
  }, 5000);

  // Graceful shutdown
  const shutdown = () => {
    console.log('[V16] 关机中...');
    if (scalper) scalper.stop();
    if (marketing101) marketing101.stop();
    if (copyTrading) copyTrading.stop();
    if (bondEngine) bondEngine.stop();
    if (kellyEngine) kellyEngine.stop();
    if (store) store.save();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('致命错误:', error);
  process.exit(1);
});
