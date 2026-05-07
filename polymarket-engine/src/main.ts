// ============================================================================
// Polymarket V13 策略引擎 - 主入口
// ============================================================================
// BTC 5分钟剥头皮 + Marketing101 模块 + 可视化面板
// 两个策略各用 50U 独立模拟盘

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
║         Polymarket V13 - 双引擎50U模拟盘                         ║
║                                                                   ║
║  策略1: BTC 5分钟剥头皮 (CLOB价格滞后套利)                       ║
║  - Binance WS → BTC实时价格 + 5分钟K线                           ║
║  - 信号汇聚 > 70% → 交易                                        ║
║  - 滞后 > 0.3% → 5秒内执行                                      ║
║  - 止盈 0.8% | 止损 0.3% | 日亏帽 2% | 硬止损 -0.4%             ║
║  - 独立资金: 50U (模拟盘)                                        ║
║                                                                   ║
║  策略2: Marketing101 引擎 (AI + MiroFish 10K模拟)                ║
║  - Claude大脑 + MiroFish蒙特卡洛 (10K循环)                       ║
║  - BTC价格模拟器 (跳跃扩散 + 均值回归)                           ║
║  - OTC柜台数据流 + 封闭订单簿分析                                ║
║  - 5源信号汇聚: 3/5同意即交易 (模拟盘)                           ║
║  - 仓位: $2-$10 (模拟50U) | 目标: $5K-$15K (实盘)              ║
║  - 独立资金: 50U (模拟盘)                                        ║
║                                                                   ║
║  模拟盘模式 | 设置API密钥后切换实盘                               ║
╚══════════════════════════════════════════════════════════════════╝
`;

const config: StrategyConfig = loadConfig();
const PORT = config.port;

// 核心组件
let scalper: ScalperEngine | null = null;
let marketing101: Marketing101Engine | null = null;
let binance: BinanceFeed | null = null;
let client: PolymarketClient | null = null;
let store: TradeStore | null = null;

async function main() {
  console.log(BANNER);

  const app = express();
  app.use(express.json());

  // 静态文件
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- API路由 ----

  // 健康检查
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      version: '13.2.0',
      引擎: scalper?.isRunning() ? '运行中' : '空闲',
      marketing101: marketing101?.isRunning() ? '运行中' : '空闲',
      模式: scalper?.getMode() || '空闲',
      binance: binance?.isConnected() || false,
      时间戳: Date.now(),
    });
  });

  // 完整引擎状态 (给面板用)
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
          m101: null,
        });
      }
      const scalperState = scalper.getState();
      const m101State = marketing101?.getState() || null;

      res.json({
        ...scalperState,
        scalperPaperBalance: scalper.getPaperBalance(),
        m101: m101State,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Marketing101 状态
  app.get('/api/m101', (_req: Request, res: Response) => {
    try {
      if (!marketing101) {
        return res.json({ running: false, message: 'Marketing101引擎未初始化' });
      }
      res.json(marketing101.getState());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Marketing101 信号
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

  // Marketing101 交易记录
  app.get('/api/m101/trades', (_req: Request, res: Response) => {
    try {
      if (!marketing101) {
        return res.json({ open: [], closed: [] });
      }
      res.json({
        open: marketing101.getOpenPositions(),
        closed: marketing101.getClosedTrades(),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 所有交易
  app.get('/api/trades', (_req: Request, res: Response) => {
    try {
      const trades = store?.getTrades() || [];
      res.json(trades);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 持仓
  app.get('/api/positions', (_req: Request, res: Response) => {
    try {
      const positions = store?.getOpenPositions() || [];
      res.json(positions);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 已平仓位
  app.get('/api/positions/closed', (_req: Request, res: Response) => {
    try {
      const trades = store?.getTrades() || [];
      const closedTrades = trades.filter(t => t.status === 'closed' && t.side === 'SELL');
      res.json(closedTrades);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 信号
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

  // 配置
  app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
      版本: 'V13.2',
      剥头皮策略: {
        启用: config.scalperEnabled,
        模式: config.scalperMode === 'paper' ? '模拟盘' : '实盘',
        滞后阈值: config.lagThreshold + '%',
        每笔风险: config.perTradeRiskPercent + '%',
        日亏帽: config.dailyCapPercent + '%',
        硬止损: config.hardStopPercent + '%',
        最低汇聚: config.minConvergence + '%',
        最大持仓: config.maxActivePositions,
        止盈: config.takeProfitScalp + '%',
        止损: config.stopLossScalp + '%',
        独立资金: '50U (模拟盘)',
      },
      marketing101策略: {
        启用: true,
        模式: '模拟盘',
        信号源: ['Claude大脑', 'MiroFish', 'BTC模拟器', 'OTC柜台', '封闭订单簿'],
        共识要求: '3/5 (60%)',
        模拟循环: 10000,
        仓位范围: '$2-$10 (模拟50U) | $5K-$15K (实盘)',
        独立资金: '50U (模拟盘)',
      },
    });
  });

  // 启动引擎
  app.post('/api/start', async (req: Request, res: Response) => {
    try {
      const mode = req.body.mode || config.scalperMode;

      if (scalper?.isRunning()) {
        return res.json({ success: false, error: '引擎已在运行' });
      }

      if (!binance) binance = new BinanceFeed(config);
      if (!client) client = new PolymarketClient(config);
      if (!store) store = new TradeStore();

      scalper = new ScalperEngine(config, binance, client, store);

      if (mode === 'live' && !config.polymarketApiKey) {
        logger.warn('未设置API密钥，回退到模拟盘');
      }

      await scalper.start();

      // 启动Marketing101引擎
      if (!marketing101) {
        marketing101 = new Marketing101Engine(config);
      }
      const btcPrice = binance.getPrice() || 80000;
      await marketing101.start(btcPrice);

      res.json({
        success: true,
        剥头皮: scalper.getMode(),
        marketing101: marketing101.isRunning() ? '运行中' : '空闲',
      });
    } catch (e: any) {
      logger.error('启动引擎失败', { error: e.message });
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 停止引擎
  app.post('/api/stop', (_req: Request, res: Response) => {
    try {
      if (scalper) {
        scalper.stop();
        scalper = null;
      }
      if (marketing101) {
        marketing101.stop();
      }
      res.json({ success: true, 消息: '引擎已停止' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 导出数据
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

  // 面板路由
  app.get('/', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
  });

  // ---- 启动服务器 ----

  app.listen(PORT, () => {
    console.log(`[V13引擎] API服务器运行于端口 ${PORT}`);
    console.log(`[V13引擎] 面板: http://localhost:${PORT}/`);
    console.log(`[V13引擎] API: http://localhost:${PORT}/api/`);
    console.log(`[V13引擎] M101 API: http://localhost:${PORT}/api/m101/`);
    console.log(`[V13引擎] 模式: ${config.scalperMode}${config.dryRun ? ' (模拟)' : ''}`);
  });

  // 自动启动
  if (config.scalperEnabled) {
    setTimeout(async () => {
      try {
        console.log('[V13引擎] 自动启动...');
        binance = new BinanceFeed(config);
        client = new PolymarketClient(config);
        store = new TradeStore();
        scalper = new ScalperEngine(config, binance, client, store);
        await scalper.start();

        marketing101 = new Marketing101Engine(config);
        const btcPrice = binance.getPrice() || 80000;
        await marketing101.start(btcPrice);

        console.log('[V13引擎] 双引擎启动成功 (剥头皮50U + M101 50U)');
      } catch (e: any) {
        console.error('[V13引擎] 自动启动失败:', e.message);
        console.log('[V13引擎] 请使用 POST /api/start 手动启动');
      }
    }, 3000);
  }

  // 更新Marketing101的BTC价格
  setInterval(() => {
    if (binance && marketing101 && scalper?.isRunning()) {
      const price = binance.getPrice();
      if (price > 0) {
        marketing101.updateBtcPrice(price, []);
      }
    }
  }, 5000);

  // 优雅关机
  const shutdown = () => {
    console.log('[V13引擎] 关机中...');
    if (scalper) scalper.stop();
    if (marketing101) marketing101.stop();
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
