// ============================================================================
// Polymarket V16 - Bond Strategy Engine
// ============================================================================
// Invests in high-probability Polymarket outcomes (like "bonds" - low risk, steady return)
// Targets markets with >90% implied probability, small edge
// Paper trading: $50 balance

import { StrategyConfig } from './config';
import { logger } from '../utils/logger';

// ---- Types ----
export interface BondMarket {
  conditionId: string;
  question: string;
  yesPrice: number;
  liquidity: number;
  daysToExpiry: number;
  annualizedReturn: number;
  riskLevel: 'AAA' | 'AA' | 'A' | 'BBB';
}

export interface BondPosition {
  id: string;
  timestamp: number;
  marketQuestion: string;
  yesPrice: number;
  size: number;
  cost: number;
  pnl: number;
  pnlPercent: number;
  status: 'open' | 'closed';
  closeTime?: number;
  closeReason?: string;
  daysHeld: number;
  riskLevel: string;
  annualizedReturn: number;
}

export interface BondState {
  running: boolean;
  paperBalance: number;
  totalPnl: number;
  dailyPnl: number;
  winRate: number;
  positionCount: number;
  tradeCount: number;
  avgAnnualizedReturn: number;
  scanCount: number;
  skipCount: number;
  startTime: number;
  openPositions: BondPosition[];
  closedTrades: BondPosition[];
  availableMarkets: BondMarket[];
}

export class BondEngine {
  private config: StrategyConfig;
  private running: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private startTime: number = 0;

  // Paper trading
  private paperBalance: number = 50;
  private maxPositionSize: number = 10;
  private minPositionSize: number = 3;

  // Stats
  private totalPnl: number = 0;
  private dailyPnl: number = 0;
  private dailyPnlResetTime: number = 0;
  private winningTrades: number = 0;
  private tradeCount: number = 0;
  private scanCount: number = 0;
  private skipCount: number = 0;

  // Position management
  private openPositions: BondPosition[] = [];
  private closedTrades: BondPosition[] = [];
  private lastTradeTime: number = 0;

  // Risk
  private maxOpenPositions: number = 5;
  private dailyCapPercent: number = 3;
  private minYesPrice: number = 0.90;  // Only buy YES when >90%
  private minLiquidity: number = 5000;
  private maxDaysToExpiry: number = 30;
  private minAnnualizedReturn: number = 15; // 15%+ annualized

  // Simulated bond markets
  private availableMarkets: BondMarket[] = [];

  constructor(config: StrategyConfig) {
    this.config = config;
    this.dailyPnlResetTime = this.getNextDayStart();
    this.generateSimulatedMarkets();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    logger.info('债券引擎启动 (50U模拟盘)', {
      可用市场数: this.availableMarkets.length,
      最低年化: this.minAnnualizedReturn + '%',
      最低概率: (this.minYesPrice * 100).toFixed(0) + '%',
    });

    // Scan every 5 minutes
    this.scanTimer = setInterval(async () => {
      if (this.running) {
        try {
          await this.runScan();
        } catch (e: any) {
          logger.debug('债券扫描错误', { error: e.message });
        }
      }
    }, 5 * 60 * 1000);

    // Monitor positions every 30 seconds
    this.positionTimer = setInterval(() => {
      if (this.running) this.monitorPositions();
    }, 30000);
  }

  stop(): void {
    this.running = false;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.positionTimer) { clearInterval(this.positionTimer); this.positionTimer = null; }
    logger.info('债券引擎已停止');
  }

  // ---- Simulated Bond Markets ----

  private generateSimulatedMarkets(): void {
    const marketTemplates = [
      { question: 'BTC年底超过$50K?', yesPrice: 0.95, daysToExpiry: 25, liquidity: 50000 },
      { question: '美联储下次会议维持利率?', yesPrice: 0.92, daysToExpiry: 14, liquidity: 120000 },
      { question: 'ETH年底超过$3000?', yesPrice: 0.88, daysToExpiry: 30, liquidity: 35000 },
      { question: '2026年Q1美国GDP正增长?', yesPrice: 0.94, daysToExpiry: 90, liquidity: 80000 },
      { question: '比特币ETF周净流入>0?', yesPrice: 0.91, daysToExpiry: 7, liquidity: 45000 },
      { question: 'USDT保持锚定?', yesPrice: 0.99, daysToExpiry: 10, liquidity: 200000 },
      { question: 'Coinbase下周无重大事故?', yesPrice: 0.97, daysToExpiry: 7, liquidity: 30000 },
      { question: 'SOL保持前十大市值?', yesPrice: 0.93, daysToExpiry: 20, liquidity: 25000 },
    ];

    this.availableMarkets = marketTemplates.map((m, i) => {
      const annualizedReturn = m.yesPrice > 0
        ? ((1 - m.yesPrice) / m.yesPrice) * (365 / m.daysToExpiry) * 100
        : 0;

      let riskLevel: 'AAA' | 'AA' | 'A' | 'BBB' = 'BBB';
      if (m.yesPrice >= 0.97) riskLevel = 'AAA';
      else if (m.yesPrice >= 0.93) riskLevel = 'AA';
      else if (m.yesPrice >= 0.90) riskLevel = 'A';

      return {
        conditionId: `bond-market-${i}`,
        question: m.question,
        yesPrice: m.yesPrice,
        liquidity: m.liquidity,
        daysToExpiry: m.daysToExpiry,
        annualizedReturn,
        riskLevel,
      };
    });
  }

  // ---- Scan & Invest ----

  private async runScan(): Promise<void> {
    this.scanCount++;
    this.resetDailyPnlIfNeeded();

    // Filter markets that meet criteria
    const eligible = this.availableMarkets.filter(
      m => m.yesPrice >= this.minYesPrice
        && m.liquidity >= this.minLiquidity
        && m.daysToExpiry <= this.maxDaysToExpiry
        && m.annualizedReturn >= this.minAnnualizedReturn
    );

    if (eligible.length === 0) { this.skipCount++; return; }

    // Sort by annualized return descending
    eligible.sort((a, b) => b.annualizedReturn - a.annualizedReturn);

    // Pick the best market not already invested in
    const investedIds = new Set(this.openPositions.map(p => p.marketQuestion));
    const bestMarket = eligible.find(m => !investedIds.has(m.question));

    if (!bestMarket) { this.skipCount++; return; }

    // Risk checks
    if (this.openPositions.length >= this.maxOpenPositions) { this.skipCount++; return; }
    if (Date.now() - this.lastTradeTime < 120000) { this.skipCount++; return; }

    const dailyCap = this.paperBalance * (this.dailyCapPercent / 100);
    if (this.dailyPnl <= -dailyCap) { this.skipCount++; return; }

    // Position sizing: conservative
    const size = Math.min(this.maxPositionSize, Math.max(this.minPositionSize, this.paperBalance * 0.15));
    if (size > this.paperBalance) { this.skipCount++; return; }

    const position: BondPosition = {
      id: `bond-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
      marketQuestion: bestMarket.question,
      yesPrice: bestMarket.yesPrice,
      size,
      cost: size,
      pnl: 0,
      pnlPercent: 0,
      status: 'open',
      daysHeld: 0,
      riskLevel: bestMarket.riskLevel,
      annualizedReturn: bestMarket.annualizedReturn,
    };

    this.openPositions.push(position);
    this.paperBalance -= size;
    this.lastTradeTime = Date.now();

    logger.info('🏦 债券投资', {
      市场: bestMarket.question,
      YES价格: bestMarket.yesPrice.toFixed(2),
      年化回报: bestMarket.annualizedReturn.toFixed(1) + '%',
      评级: bestMarket.riskLevel,
      金额: '$' + size.toFixed(2),
      剩余资金: '$' + this.paperBalance.toFixed(2),
    });
  }

  // ---- Position Monitor ----

  private monitorPositions(): void {
    const positionsToClose: BondPosition[] = [];

    for (const pos of this.openPositions) {
      const daysHeld = (Date.now() - pos.timestamp) / (24 * 60 * 60 * 1000);
      pos.daysHeld = daysHeld;

      // Simulate: high-probability markets mostly win
      const winProb = pos.yesPrice;
      const shouldSettle = daysHeld >= 1 && Math.random() < 0.1; // 10% chance of settling each check after 1 day

      if (shouldSettle || daysHeld > 7) {
        const isWin = Math.random() < winProb;
        const pnlPercent = isWin
          ? ((1 - pos.yesPrice) / pos.yesPrice) * 100  // Earn: (1 - yesPrice) / yesPrice
          : -(100 * pos.yesPrice / (1 - pos.yesPrice)) * 0.1; // Lose: fraction of cost

        const pnl = pos.cost * (pnlPercent / 100);
        const clampedPnl = Math.max(-pos.cost, pnl);

        pos.pnl = clampedPnl;
        pos.pnlPercent = pnlPercent;
        pos.status = 'closed';
        pos.closeTime = Date.now();
        pos.closeReason = isWin ? '到期获利' : '市场反转';

        this.closedTrades.push(pos);
        this.tradeCount++;
        this.totalPnl += clampedPnl;
        this.dailyPnl += clampedPnl;
        if (clampedPnl > 0) this.winningTrades++;
        this.paperBalance = Math.max(0, this.paperBalance + pos.cost + clampedPnl);

        positionsToClose.push(pos);

        logger.info('🏦 债券到期', {
          市场: pos.marketQuestion,
          结果: isWin ? '获利' : '亏损',
          盈亏: (clampedPnl >= 0 ? '+' : '') + '$' + clampedPnl.toFixed(4),
          剩余资金: '$' + this.paperBalance.toFixed(2),
        });
      }
    }

    for (const pos of positionsToClose) {
      const idx = this.openPositions.indexOf(pos);
      if (idx >= 0) this.openPositions.splice(idx, 1);
    }

    if (this.closedTrades.length > 200) {
      this.closedTrades = this.closedTrades.slice(-200);
    }
  }

  // ---- Helpers ----

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
    }
  }

  // ---- Public Interface ----

  getState(): BondState {
    const avgReturn = this.openPositions.length > 0
      ? this.openPositions.reduce((s, p) => s + p.annualizedReturn, 0) / this.openPositions.length
      : 0;

    return {
      running: this.running,
      paperBalance: this.paperBalance,
      totalPnl: this.totalPnl,
      dailyPnl: this.dailyPnl,
      winRate: this.tradeCount > 0 ? (this.winningTrades / this.tradeCount) * 100 : 0,
      positionCount: this.openPositions.length,
      tradeCount: this.tradeCount,
      avgAnnualizedReturn: avgReturn,
      scanCount: this.scanCount,
      skipCount: this.skipCount,
      startTime: this.startTime,
      openPositions: this.openPositions,
      closedTrades: this.closedTrades.slice(-50),
      availableMarkets: this.availableMarkets,
    };
  }

  isRunning(): boolean { return this.running; }
  getPaperBalance(): number { return this.paperBalance; }
  getOpenPositions(): BondPosition[] { return this.openPositions; }
  getClosedTrades(): BondPosition[] { return this.closedTrades.slice(-50); }
}
