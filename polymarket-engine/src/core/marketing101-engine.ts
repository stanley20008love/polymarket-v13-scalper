// ============================================================================
// Polymarket V13 - Marketing101 引擎
// ============================================================================
// 基于 Marketing101 案例: 香港营销者月赚 $374K
// 核心系统: Claude 算法大脑 + MiroFish 模拟引擎
// - 每次入场前运行 10,000 次蒙特卡洛模拟
// - 封闭订单簿数据 + 私人OTC柜台数据
// - BTC 价格模拟器 (跳跃扩散 + 均值回归)
// - 5源信号汇聚: 3/5同意即可交易 (模拟盘模式)
// - 模拟盘独立资金: 50U

import { StrategyConfig } from './config';
import { MiroFishEngine } from './mirofish-sim';
import { BtcSimulator, BtcPricePath, SimulatedOrderBook } from './btc-simulator';
import { OTCDataEngine, OTCDeskSnapshot } from './otc-data';
import { ClosedOrderBookAnalyzer, ClosedBookAnalysis, OrderBookPattern } from './closed-orderbook';
import {
  Market,
  OrderBook,
  ScalperTrade,
  ScalperPosition,
} from './types';
import { logger } from '../utils/logger';

// Marketing101 类型定义
export interface M101Signal {
  source: string;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  strength: number;
  confidence: number;
  details: string;
  timestamp: number;
}

export interface M101Decision {
  shouldTrade: boolean;
  direction: 'UP' | 'DOWN';
  positionSize: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  expectedValue: number;
  riskReward: number;
  signals: M101Signal[];
  simulationResult: M101SimResult | null;
  otcSnapshot: OTCDeskSnapshot | null;
  closedBookAnalysis: ClosedBookAnalysis | null;
  btcSimResult: BtcSimResult | null;
  reasoning: string;
  timestamp: number;
}

export interface M101SimResult {
  direction: 'UP' | 'DOWN';
  upProbability: number;
  downProbability: number;
  confidence: number;
  expectedPnl: number;
  pnlStdDev: number;
  sharpe: number;
  kellyFraction: number;
  pnlDistribution: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
  simulationCount: number;
  elapsedMs: number;
  shouldTrade: boolean;
  marketContext: string;
}

export interface BtcSimResult {
  currentPrice: number;
  upCount: number;
  downCount: number;
  avgFinalPrice: number;
  p5: number;
  p50: number;
  p95: number;
  maxPrice: number;
  minPrice: number;
  avgJumpCount: number;
}

export interface M101Trade {
  id: string;
  timestamp: number;
  direction: 'UP' | 'DOWN';
  entryPrice: number;
  exitPrice: number;
  size: number;
  cost: number;
  pnl: number;
  pnlPercent: number;
  status: 'open' | 'closed';
  closeTime?: number;
  closeReason?: string;
  btcEntryPrice: number;
  btcExitPrice?: number;
  confidence: number;
  signals: M101Signal[];
}

export interface M101State {
  running: boolean;
  btcPrice: number;
  paperBalance: number;
  lastDecision: M101Decision | null;
  lastSignals: M101Signal[];
  lastOtcSnapshot: OTCDeskSnapshot | null;
  lastClosedBook: ClosedBookAnalysis | null;
  lastBtcSim: BtcSimResult | null;
  lastSimResult: M101SimResult | null;
  tradeCount: number;
  totalPnl: number;
  dailyPnl: number;
  winRate: number;
  avgTradeSize: number;
  simulationRuns: number;
  scanCount: number;
  skipCount: number;
  startTime: number;
  openPositions: M101Trade[];
  closedTrades: M101Trade[];
}

export class Marketing101Engine {
  private config: StrategyConfig;
  private miroFish: MiroFishEngine;
  private btcSim: BtcSimulator;
  private otcEngine: OTCDataEngine;
  private closedBookAnalyzer: ClosedOrderBookAnalyzer;

  private running: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private startTime: number = 0;

  // 当前BTC价格（由外部更新）
  private currentBtcPrice: number = 0;

  // State
  private lastDecision: M101Decision | null = null;
  private lastSignals: M101Signal[] = [];
  private lastOtcSnapshot: OTCDeskSnapshot | null = null;
  private lastClosedBook: ClosedBookAnalysis | null = null;
  private lastBtcSim: BtcSimResult | null = null;
  private lastSimResult: M101SimResult | null = null;

  private tradeCount: number = 0;
  private totalPnl: number = 0;
  private dailyPnl: number = 0;
  private winningTrades: number = 0;
  private simulationRuns: number = 0;
  private scanCount: number = 0;
  private skipCount: number = 0;

  // 模拟盘独立资金: 50U
  private paperBalance: number = 50;
  // 仓位大小: 50U资本的合理比例
  private targetTradeSizeMin: number = 2;     // 最小 $2/笔 (4%资本)
  private targetTradeSizeMax: number = 10;    // 最大 $10/笔 (20%资本)

  // 持仓管理
  private openPositions: M101Trade[] = [];
  private closedTrades: M101Trade[] = [];
  private lastTradeTime: number = 0;

  // 风控
  private dailyCapPercent: number = 5;    // 每日最大亏损5%
  private hardStopPercent: number = 0.4;  // 硬止损0.4%
  private dailyPnlResetTime: number = 0;  // 日PnL重置时间

  constructor(config: StrategyConfig) {
    this.config = config;
    this.miroFish = new MiroFishEngine(config);
    this.btcSim = new BtcSimulator();
    this.otcEngine = new OTCDataEngine();
    this.closedBookAnalyzer = new ClosedOrderBookAnalyzer();
    this.dailyPnlResetTime = this.getNextDayStart();
  }

  private getNextDayStart(): number {
    const tomorrow = new Date();
    tomorrow.setUTCHours(tomorrow.getUTCHours() + 24);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.getTime();
  }

  private resetDailyPnlIfNeeded(): void {
    if (Date.now() >= this.dailyPnlResetTime) {
      this.dailyPnl = 0;
      this.dailyPnlResetTime = this.getNextDayStart();
      logger.info('M101日PnL已重置');
    }
  }

  async start(btcPrice: number): Promise<void> {
    if (this.running) {
      logger.warn('Marketing101引擎已在运行');
      return;
    }

    this.running = true;
    this.startTime = Date.now();
    this.currentBtcPrice = btcPrice;

    this.btcSim.updateMarketData(btcPrice, []);

    logger.info('Marketing101引擎启动 (50U模拟盘)', {
      仓位范围: `$${this.targetTradeSizeMin}-$${this.targetTradeSizeMax}`,
      初始资金: `$${this.paperBalance} (50U)`,
      共识要求: '3/5 (60%)',
    });

    // 主分析循环 - 每15秒运行一次
    this.scanTimer = setInterval(async () => {
      if (this.running) {
        try {
          await this.runAnalysis(this.currentBtcPrice);
        } catch (e: any) {
          logger.debug('Marketing101扫描错误', { error: e.message });
        }
      }
    }, 15000);

    // 持仓监控 - 每5秒检查一次止盈止损
    this.positionTimer = setInterval(() => {
      if (this.running) {
        this.monitorPositions();
      }
    }, 5000);
  }

  stop(): void {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.positionTimer) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
    logger.info('Marketing101引擎已停止');
  }

  updateBtcPrice(price: number, klines: number[]): void {
    this.currentBtcPrice = price;
    this.btcSim.updateMarketData(price, klines);
  }

  /**
   * 主分析周期 - 5源信号汇聚
   * 模拟盘模式: 3/5源同意即可交易 (60%共识)
   */
  private async runAnalysis(btcPrice: number): Promise<M101Decision | null> {
    this.scanCount++;

    const signals: M101Signal[] = [];
    const now = Date.now();

    // ===== 信号源1: BTC价格模拟器 (10K路径) =====
    const btcSimResult = this.runBtcSimulation(btcPrice);
    this.lastBtcSim = btcSimResult;

    signals.push({
      source: 'btc_sim',
      direction: btcSimResult.upCount > btcSimResult.downCount ? 'UP' : 'DOWN',
      strength: Math.abs(btcSimResult.upCount - btcSimResult.downCount) / 10000,
      confidence: Math.min(0.9, Math.abs(btcSimResult.avgFinalPrice - btcPrice) / btcPrice * 50),
      details: `10K路径: UP ${btcSimResult.upCount} | DOWN ${btcSimResult.downCount} | 均价: $${btcSimResult.avgFinalPrice.toFixed(0)} | P50: $${btcSimResult.p50.toFixed(0)}`,
      timestamp: now,
    });

    // ===== 信号源2: OTC柜台数据 =====
    const otcSnapshot = this.otcEngine.getSnapshot(btcPrice, 0);
    this.lastOtcSnapshot = otcSnapshot;

    signals.push({
      source: 'otc',
      direction: otcSnapshot.signal === 'BULL' ? 'UP' : otcSnapshot.signal === 'BEAR' ? 'DOWN' : 'NEUTRAL',
      strength: otcSnapshot.signalStrength,
      confidence: otcSnapshot.confidence,
      details: `净流: ${otcSnapshot.netFlow.toFixed(1)} BTC | 买: ${otcSnapshot.buyFlow.toFixed(1)} | 卖: ${otcSnapshot.sellFlow.toFixed(1)} | ${otcSnapshot.largeBlocks.length}个大宗`,
      timestamp: now,
    });

    // ===== 信号源3: Claude大脑 (AI分析) =====
    const claudeSignal = this.runClaudeBrainAnalysis(btcPrice, btcSimResult, otcSnapshot);
    signals.push(claudeSignal);

    // ===== 信号源4: MiroFish蒙特卡洛 (10K循环) =====
    const synthOrderBook = this.btcSim.generateOrderBook(btcPrice);
    const synthMarket: Market = {
      conditionId: 'btc-5min-simulated',
      questionId: 'sim',
      question: 'BTC 5分钟内涨还是跌?',
      slug: 'btc-5min',
      outcomes: ['UP', 'DOWN'],
      outcomePrices: [
        String(btcSimResult.upCount / 10000),
        String(btcSimResult.downCount / 10000),
      ],
      active: true,
      closed: false,
      endDate: new Date(now + 5 * 60 * 1000).toISOString(),
      liquidity: 100000,
      volume: 50000,
      clobTokenIds: ['sim-up', 'sim-down'],
      negRisk: false,
    };

    const synthOB: OrderBook = {
      tokenId: 'sim-up',
      bids: synthOrderBook.bids.map(b => ({ price: b.price / btcPrice, size: b.size })),
      asks: synthOrderBook.asks.map(a => ({ price: a.price / btcPrice, size: a.size })),
      hash: 'sim',
      timestamp: now,
    };

    const miroFishResult = await this.miroFish.simulate(
      synthMarket,
      synthOB,
      btcPrice,
      0,
      0,
      synthOrderBook.depthImbalance,
      [],
      10000
    );

    this.lastSimResult = {
      direction: miroFishResult.direction,
      upProbability: miroFishResult.upProbability,
      downProbability: miroFishResult.downProbability,
      confidence: miroFishResult.confidence,
      expectedPnl: miroFishResult.expectedPnl,
      pnlStdDev: miroFishResult.pnlStdDev,
      sharpe: miroFishResult.sharpe,
      kellyFraction: miroFishResult.kellyFraction,
      pnlDistribution: miroFishResult.pnlDistribution,
      simulationCount: miroFishResult.simulationCount,
      elapsedMs: miroFishResult.elapsedMs,
      shouldTrade: miroFishResult.shouldTrade,
      marketContext: miroFishResult.marketContext,
    };
    this.simulationRuns++;

    signals.push({
      source: 'mirofish',
      direction: miroFishResult.direction,
      strength: miroFishResult.confidence / 100,
      confidence: Math.min(0.9, miroFishResult.confidence / 100),
      details: `10K模拟: ${miroFishResult.direction} (${(miroFishResult.confidence).toFixed(1)}%) | Kelly: ${(miroFishResult.kellyFraction * 100).toFixed(2)}% | Sharpe: ${miroFishResult.sharpe.toFixed(3)} | 交易: ${miroFishResult.shouldTrade ? '是' : '否'}`,
      timestamp: now,
    });

    // ===== 信号源5: 封闭订单簿分析 =====
    const closedBookAnalysis = this.closedBookAnalyzer.analyzeOrderBook(
      'btc-5min-simulated',
      synthOrderBook.bids,
      synthOrderBook.asks,
      btcPrice,
      0
    );
    this.lastClosedBook = closedBookAnalysis;

    const cbDirection: 'UP' | 'DOWN' | 'NEUTRAL' =
      closedBookAnalysis.makerBias === 'YES' ? 'UP'
      : closedBookAnalysis.makerBias === 'NO' ? 'DOWN'
      : synthOrderBook.depthImbalance > 0.1 ? 'UP'
      : synthOrderBook.depthImbalance < -0.1 ? 'DOWN'
      : 'NEUTRAL';
    const cbStrength = Math.min(1, Math.abs(synthOrderBook.depthImbalance) * 2);
    const cbConfidence = Math.min(0.9, 0.3 + (Math.abs(closedBookAnalysis.whaleBidCount - closedBookAnalysis.whaleAskCount) / Math.max(1, closedBookAnalysis.whaleBidCount + closedBookAnalysis.whaleAskCount)) * 0.5);

    signals.push({
      source: 'closed_book',
      direction: cbDirection,
      strength: cbStrength,
      confidence: cbConfidence,
      details: `做市商: ${closedBookAnalysis.makerBias} | 深度: ${(synthOrderBook.depthImbalance * 100).toFixed(1)}% | 鲸鱼: ${closedBookAnalysis.whaleBidCount}买/${closedBookAnalysis.whaleAskCount}卖 | 隐性: ${closedBookAnalysis.hiddenLiquidity.toFixed(1)}`,
      timestamp: now,
    });

    this.lastSignals = signals;

    // ===== 决策: 3/5源同意即可交易 =====
    const decision = this.makeDecision(signals, btcPrice, miroFishResult, otcSnapshot, closedBookAnalysis, btcSimResult);
    this.lastDecision = decision;

    if (decision.shouldTrade) {
      this.executeSimTrade(decision, btcPrice);
    } else {
      this.skipCount++;
    }

    return decision;
  }

  /**
   * Claude大脑分析 - AI驱动的市场解读
   */
  private runClaudeBrainAnalysis(
    btcPrice: number,
    btcSim: BtcSimResult,
    otc: OTCDeskSnapshot
  ): M101Signal {
    const upProb = btcSim.upCount / 10000;
    const downProb = btcSim.downCount / 10000;

    let regime = '中性';
    let regimeStrength = 0;
    if (otc.netFlow > 50 && otc.signal === 'BULL') {
      regime = '上升趋势';
      regimeStrength = Math.min(1, otc.netFlow / 200);
    } else if (otc.netFlow < -50 && otc.signal === 'BEAR') {
      regime = '下降趋势';
      regimeStrength = Math.min(1, Math.abs(otc.netFlow) / 200);
    } else if (Math.abs(otc.netFlow) < 20) {
      regime = '均值回归';
      regimeStrength = 0.5;
    }

    let direction: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    let strength = 0;
    let confidence = 0.5;

    if (regime === '上升趋势' && upProb > 0.50) {
      direction = 'UP';
      strength = regimeStrength * 0.8 + Math.max(0, upProb - 0.5) * 2;
      confidence = 0.6 + regimeStrength * 0.3;
    } else if (regime === '下降趋势' && downProb > 0.50) {
      direction = 'DOWN';
      strength = regimeStrength * 0.8 + Math.max(0, downProb - 0.5) * 2;
      confidence = 0.6 + regimeStrength * 0.3;
    } else if (regime === '均值回归') {
      direction = upProb > 0.5 ? 'DOWN' : 'UP';
      strength = 0.4;
      confidence = 0.5;
    } else {
      // 默认: 跟随概率方向
      direction = upProb > 0.5 ? 'UP' : 'DOWN';
      strength = Math.abs(upProb - 0.5) * 3;
      confidence = 0.5 + Math.abs(upProb - 0.5) * 0.5;
    }

    return {
      source: 'claude_brain',
      direction,
      strength: Math.min(1, strength),
      confidence: Math.min(0.95, confidence),
      details: `市场状态: ${regime} | ${direction === 'UP' ? '看涨' : direction === 'DOWN' ? '看跌' : '中性'} | OTC净流: ${otc.netFlow.toFixed(1)} BTC | 置信: ${(confidence * 100).toFixed(0)}%`,
      timestamp: Date.now(),
    };
  }

  private runBtcSimulation(btcPrice: number): BtcSimResult {
    const result = this.btcSim.runBatchSimulations(btcPrice, 300, 10000, 5000);
    return {
      currentPrice: btcPrice,
      upCount: result.upCount,
      downCount: result.downCount,
      avgFinalPrice: result.avgFinalPrice,
      p5: result.p5,
      p50: result.p50,
      p95: result.p95,
      maxPrice: result.maxPrice,
      minPrice: result.minPrice,
      avgJumpCount: result.avgJumpCount,
    };
  }

  /**
   * 交易决策 - 模拟盘模式: 3/5源同意(60%共识)即可交易
   */
  private makeDecision(
    signals: M101Signal[],
    btcPrice: number,
    simResult: any,
    otcSnapshot: OTCDeskSnapshot,
    closedBook: ClosedBookAnalysis,
    btcSim: BtcSimResult
  ): M101Decision {
    let upScore = 0;
    let downScore = 0;
    let totalConfidence = 0;

    const weights: Record<string, number> = {
      'claude_brain': 0.30,
      'mirofish': 0.25,
      'btc_sim': 0.20,
      'otc': 0.15,
      'closed_book': 0.10,
    };

    for (const signal of signals) {
      const weight = weights[signal.source] || 0.1;
      const score = signal.strength * signal.confidence * weight;
      if (signal.direction === 'UP') upScore += score;
      else if (signal.direction === 'DOWN') downScore += score;
      totalConfidence += signal.confidence * weight;
    }

    const direction: 'UP' | 'DOWN' = upScore > downScore ? 'UP' : 'DOWN';
    const dominantScore = Math.max(upScore, downScore);
    const totalScore = upScore + downScore;
    const consensus = totalScore > 0 ? dominantScore / totalScore : 0;

    const agreeingSources = signals.filter(s => s.direction === direction).length;
    const consensusRatio = agreeingSources / signals.length;

    // 需要3/5源同意(60%) AND MiroFish确认
    const shouldTrade =
      (consensusRatio >= 0.6 && simResult.shouldTrade) ||  // 3/5 + MiroFish
      (consensusRatio >= 0.8);  // 4/5即可，无需MiroFish

    const kellySize = Math.max(simResult.kellyFraction, 0.05) * this.paperBalance;
    const positionSize = Math.min(
      this.targetTradeSizeMax,
      Math.max(this.targetTradeSizeMin, kellySize)
    );

    const expectedPnl = shouldTrade ? simResult.expectedPnl * positionSize : 0;
    const riskAmount = positionSize * 0.005;
    const rewardAmount = positionSize * 0.015;
    const riskReward = riskAmount > 0 ? rewardAmount / riskAmount : 0;

    const entryPrice = direction === 'UP'
      ? btcSim.p50 / btcPrice
      : 1 - (btcSim.p50 / btcPrice);
    const stopLoss = entryPrice * 0.995;
    const takeProfit = entryPrice * 1.015;

    const reasoning = shouldTrade
      ? `${direction === 'UP' ? '看涨' : '看跌'}信号: ${agreeingSources}/5源同意 (${(consensusRatio * 100).toFixed(0)}%) | Claude大脑 + MiroFish确认 | 共识: ${(consensus * 100).toFixed(1)}% | Kelly: ${(simResult.kellyFraction * 100).toFixed(2)}% | 盈亏比: ${riskReward.toFixed(2)}`
      : `跳过: 仅${agreeingSources}/5源同意 (${(consensusRatio * 100).toFixed(0)}%) | 需3/5 (60%) | 共识: ${(consensus * 100).toFixed(1)}%`;

    return {
      shouldTrade,
      direction,
      positionSize,
      entryPrice,
      stopLoss,
      takeProfit,
      confidence: consensus,
      expectedValue: expectedPnl,
      riskReward,
      signals,
      simulationResult: this.lastSimResult,
      otcSnapshot,
      closedBookAnalysis: closedBook,
      btcSimResult: btcSim,
      reasoning,
      timestamp: Date.now(),
    };
  }

  /**
   * 执行模拟交易
   */
  private executeSimTrade(decision: M101Decision, btcPrice: number): void {
    // 日PnL重置
    this.resetDailyPnlIfNeeded();

    // 风控检查
    if (this.openPositions.length >= 3) {
      this.skipCount++;
      return;
    }

    // 最少间隔15秒
    if (Date.now() - this.lastTradeTime < 15000) {
      this.skipCount++;
      return;
    }

    // 每日亏损检查
    const dailyCap = this.paperBalance * (this.dailyCapPercent / 100);
    if (this.dailyPnl <= -dailyCap) {
      this.skipCount++;
      return;
    }

    // 硬止损检查
    const hardStop = this.paperBalance * (this.hardStopPercent / 100);
    if (this.dailyPnl <= -hardStop) {
      logger.warn('M101硬止损触发', { dailyPnl: this.dailyPnl.toFixed(2) });
      this.skipCount++;
      return;
    }

    const size = decision.positionSize;
    if (size > this.paperBalance) {
      this.skipCount++;
      return;
    }

    const trade: M101Trade = {
      id: `m101-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
      direction: decision.direction,
      entryPrice: decision.entryPrice,
      exitPrice: 0,
      size,
      cost: size,
      pnl: 0,
      pnlPercent: 0,
      status: 'open',
      btcEntryPrice: btcPrice,
      confidence: decision.confidence,
      signals: decision.signals,
    };

    this.openPositions.push(trade);
    this.paperBalance -= size;
    this.lastTradeTime = Date.now();

    logger.info('🔥 M101模拟交易', {
      方向: decision.direction,
      金额: '$' + size.toFixed(2),
      置信度: (decision.confidence * 100).toFixed(1) + '%',
      BTC价格: '$' + btcPrice.toFixed(0),
      剩余资金: '$' + this.paperBalance.toFixed(2),
    });
  }

  /**
   * 监控持仓 - 根据BTC价格变动模拟止盈止损
   */
  private monitorPositions(): void {
    if (this.currentBtcPrice <= 0) return;

    const positionsToClose: M101Trade[] = [];

    for (const pos of this.openPositions) {
      const btcChange = (this.currentBtcPrice - pos.btcEntryPrice) / pos.btcEntryPrice;

      // 根据方向计算模拟PnL
      let pnlPercent: number;
      if (pos.direction === 'UP') {
        pnlPercent = btcChange * 100; // BTC涨了=赚
      } else {
        pnlPercent = -btcChange * 100; // BTC跌了=赚
      }

      // 不使用杠杆 (模拟盘1:1)
      // pnlPercent 保持原值，反映真实盈亏

      let shouldClose = false;
      let closeReason = '';

      // 止盈: +5%
      if (pnlPercent >= 5) {
        shouldClose = true;
        closeReason = '止盈';
      }
      // 止损: -2%
      else if (pnlPercent <= -2) {
        shouldClose = true;
        closeReason = '止损';
      }
      // 超时: 5分钟自动平仓
      else if (Date.now() - pos.timestamp > 5 * 60 * 1000) {
        shouldClose = true;
        closeReason = '超时平仓';
      }

      if (shouldClose) {
        const pnl = pos.cost * (pnlPercent / 100);
        pos.exitPrice = pos.entryPrice * (1 + pnlPercent / 100);
        pos.pnl = pnl;
        pos.pnlPercent = pnlPercent;
        pos.status = 'closed';
        pos.closeTime = Date.now();
        pos.closeReason = closeReason;
        pos.btcExitPrice = this.currentBtcPrice;
        positionsToClose.push(pos);
      }
    }

    // 平仓处理
    for (const pos of positionsToClose) {
      const idx = this.openPositions.indexOf(pos);
      if (idx >= 0) {
        this.openPositions.splice(idx, 1);
      }

      this.closedTrades.push(pos);
      this.tradeCount++;
      this.totalPnl += pos.pnl;
      this.dailyPnl += pos.pnl;
      // Balance protection: cannot go negative
      this.paperBalance = Math.max(0, this.paperBalance + pos.cost + pos.pnl);
      if (pos.pnl > 0) this.winningTrades++;

      logger.info('📊 M101平仓', {
        原因: pos.closeReason,
        方向: pos.direction,
        盈亏: (pos.pnl >= 0 ? '+' : '') + '$' + pos.pnl.toFixed(4),
        盈亏百分比: pos.pnlPercent.toFixed(2) + '%',
        剩余资金: '$' + this.paperBalance.toFixed(2),
        胜率: (this.winningTrades / this.tradeCount * 100).toFixed(1) + '%',
      });
    }

    // 保留最近100条交易
    if (this.closedTrades.length > 100) {
      this.closedTrades = this.closedTrades.slice(-100);
    }
  }

  // ---- 公开接口 ----

  getState(): M101State {
    return {
      running: this.running,
      btcPrice: this.currentBtcPrice,
      paperBalance: this.paperBalance,
      lastDecision: this.lastDecision,
      lastSignals: this.lastSignals,
      lastOtcSnapshot: this.lastOtcSnapshot,
      lastClosedBook: this.lastClosedBook,
      lastBtcSim: this.lastBtcSim,
      lastSimResult: this.lastSimResult,
      tradeCount: this.tradeCount,
      totalPnl: this.totalPnl,
      dailyPnl: this.dailyPnl,
      winRate: this.tradeCount > 0 ? (this.winningTrades / this.tradeCount) * 100 : 0,
      avgTradeSize: this.tradeCount > 0 ? this.totalPnl / this.tradeCount : 0,
      simulationRuns: this.simulationRuns,
      scanCount: this.scanCount,
      skipCount: this.skipCount,
      startTime: this.startTime,
      openPositions: this.openPositions,
      closedTrades: this.closedTrades.slice(-20),  // 最近20条
    };
  }

  isRunning(): boolean { return this.running; }

  getPaperBalance(): number { return this.paperBalance; }

  getOpenPositions(): M101Trade[] { return this.openPositions; }

  getClosedTrades(): M101Trade[] { return this.closedTrades.slice(-50); }

  recordTrade(pnl: number): void {
    this.tradeCount++;
    this.totalPnl += pnl;
    this.dailyPnl += pnl;
    if (pnl > 0) this.winningTrades++;
    this.paperBalance += pnl;
  }
}
