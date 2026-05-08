// ============================================================================
// Polymarket V16 - Copy Trading Engine
// ============================================================================
// Scans profitable wallets (>90% win rate, >$100K profit) and auto-copies
// Paper trading: $50 balance

import { StrategyConfig } from './config';
import { PolymarketClient } from '../services/polymarket-client';
import { logger } from '../utils/logger';

// ---- Types ----
export interface WalletProfile {
  address: string;
  totalPnl: number;
  winRate: number;
  totalTrades: number;
  avgTradeSize: number;
  lastActive: number;
  preferredMarkets: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface CopyTrade {
  id: string;
  timestamp: number;
  sourceWallet: string;
  direction: 'UP' | 'DOWN';
  marketQuestion: string;
  entryPrice: number;
  exitPrice: number;
  size: number;
  cost: number;
  pnl: number;
  pnlPercent: number;
  status: 'open' | 'closed';
  closeTime?: number;
  closeReason?: string;
  confidence: number;
}

export interface CopyTradingState {
  running: boolean;
  paperBalance: number;
  trackedWallets: number;
  profitableWallets: number;
  totalPnl: number;
  dailyPnl: number;
  winRate: number;
  tradeCount: number;
  scanCount: number;
  skipCount: number;
  startTime: number;
  openPositions: CopyTrade[];
  closedTrades: CopyTrade[];
  topWallets: WalletProfile[];
}

export class CopyTradingEngine {
  private config: StrategyConfig;
  private running: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private positionTimer: NodeJS.Timeout | null = null;
  private startTime: number = 0;

  // Paper trading
  private paperBalance: number = 50;
  private maxPositionSize: number = 8;
  private minPositionSize: number = 2;

  // Stats
  private totalPnl: number = 0;
  private dailyPnl: number = 0;
  private dailyPnlResetTime: number = 0;
  private winningTrades: number = 0;
  private tradeCount: number = 0;
  private scanCount: number = 0;
  private skipCount: number = 0;

  // Wallet tracking
  private trackedWallets: WalletProfile[] = [];
  private openPositions: CopyTrade[] = [];
  private closedTrades: CopyTrade[] = [];
  private lastTradeTime: number = 0;

  // Risk
  private maxOpenPositions: number = 3;
  private dailyCapPercent: number = 5;
  private minWalletWinRate: number = 0.90; // 90%+ win rate
  private minWalletProfit: number = 100000; // $100K+ profit

  constructor(config: StrategyConfig) {
    this.config = config;
    this.dailyPnlResetTime = this.getNextDayStart();
    this.generateSimulatedWallets();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    logger.info('跟单引擎启动 (50U模拟盘)', {
      追踪钱包数: this.trackedWallets.length,
      达标钱包数: this.trackedWallets.filter(w => w.winRate >= this.minWalletWinRate).length,
    });

    // Scan every 60 seconds
    this.scanTimer = setInterval(async () => {
      if (this.running) {
        try {
          await this.runScan();
        } catch (e: any) {
          logger.debug('跟单扫描错误', { error: e.message });
        }
      }
    }, 60000);

    // Monitor positions every 15 seconds
    this.positionTimer = setInterval(() => {
      if (this.running) this.monitorPositions();
    }, 15000);
  }

  stop(): void {
    this.running = false;
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
    if (this.positionTimer) { clearInterval(this.positionTimer); this.positionTimer = null; }
    logger.info('跟单引擎已停止');
  }

  // ---- Simulated Wallet Profiles ----
  // In production, these would come from Polymarket leaderboard API or on-chain analysis

  private generateSimulatedWallets(): void {
    const walletTemplates = [
      { address: '0x7A3b...f1E2', winRate: 0.94, totalPnl: 287000, totalTrades: 312, riskLevel: 'LOW' as const },
      { address: '0x9C4d...a3B7', winRate: 0.91, totalPnl: 156000, totalTrades: 198, riskLevel: 'LOW' as const },
      { address: '0x2E8f...c5D1', winRate: 0.88, totalPnl: 445000, totalTrades: 523, riskLevel: 'MEDIUM' as const },
      { address: '0x5B1a...e8F4', winRate: 0.92, totalPnl: 112000, totalTrades: 167, riskLevel: 'LOW' as const },
      { address: '0xD6c3...b2A9', winRate: 0.85, totalPnl: 890000, totalTrades: 742, riskLevel: 'HIGH' as const },
      { address: '0xF4e7...d6C0', winRate: 0.96, totalPnl: 203000, totalTrades: 89, riskLevel: 'LOW' as const },
      { address: '0x8A2b...f9E5', winRate: 0.78, totalPnl: 56000, totalTrades: 234, riskLevel: 'MEDIUM' as const },
      { address: '0x3D5c...a1B8', winRate: 0.93, totalPnl: 178000, totalTrades: 276, riskLevel: 'LOW' as const },
    ];

    this.trackedWallets = walletTemplates.map(w => ({
      ...w,
      avgTradeSize: w.totalPnl / w.totalTrades,
      lastActive: Date.now() - Math.random() * 3600000,
      preferredMarkets: ['BTC价格', '美国政治', '加密货币'],
    }));
  }

  // ---- Scan & Copy ----

  private async runScan(): Promise<void> {
    this.scanCount++;
    this.resetDailyPnlIfNeeded();

    // Find profitable wallets that meet criteria
    const profitableWallets = this.trackedWallets.filter(
      w => w.winRate >= this.minWalletWinRate && w.totalPnl >= this.minWalletProfit
    );

    if (profitableWallets.length === 0) {
      this.skipCount++;
      return;
    }

    // Simulate: pick a random profitable wallet's recent trade
    const wallet = profitableWallets[Math.floor(Math.random() * profitableWallets.length)];

    // Simulate a trade signal from this wallet
    const shouldCopy = Math.random() < wallet.winRate;
    if (!shouldCopy) {
      this.skipCount++;
      return;
    }

    const direction: 'UP' | 'DOWN' = Math.random() > 0.5 ? 'UP' : 'DOWN';
    const size = Math.min(this.maxPositionSize, Math.max(this.minPositionSize, this.paperBalance * 0.1));
    const entryPrice = 0.4 + Math.random() * 0.2; // 0.4-0.6 range

    // Risk checks
    if (this.openPositions.length >= this.maxOpenPositions) { this.skipCount++; return; }
    if (Date.now() - this.lastTradeTime < 60000) { this.skipCount++; return; }
    if (size > this.paperBalance) { this.skipCount++; return; }

    const dailyCap = this.paperBalance * (this.dailyCapPercent / 100);
    if (this.dailyPnl <= -dailyCap) { this.skipCount++; return; }

    const trade: CopyTrade = {
      id: `copy-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp: Date.now(),
      sourceWallet: wallet.address,
      direction,
      marketQuestion: `${direction === 'UP' ? '看涨' : '看跌'}信号 (跟单 ${wallet.address.slice(0, 8)}...)`,
      entryPrice,
      exitPrice: 0,
      size,
      cost: size,
      pnl: 0,
      pnlPercent: 0,
      status: 'open',
      confidence: wallet.winRate,
    };

    this.openPositions.push(trade);
    this.paperBalance -= size;
    this.lastTradeTime = Date.now();

    logger.info('📋 跟单交易', {
      钱包: wallet.address,
      胜率: (wallet.winRate * 100).toFixed(0) + '%',
      总盈利: '$' + wallet.totalPnl.toLocaleString(),
      金额: '$' + size.toFixed(2),
      剩余资金: '$' + this.paperBalance.toFixed(2),
    });
  }

  // ---- Position Monitor ----

  private monitorPositions(): void {
    const positionsToClose: CopyTrade[] = [];

    for (const pos of this.openPositions) {
      // Simulate: use win rate of source wallet as probability
      const isWin = Math.random() < pos.confidence;
      const pnlPercent = isWin
        ? 5 + Math.random() * 20   // +5% to +25%
        : -(5 + Math.random() * 15); // -5% to -20%

      // Auto-close after 10 minutes
      if (Date.now() - pos.timestamp > 10 * 60 * 1000) {
        const pnl = pos.cost * (pnlPercent / 100);
        const clampedPnl = Math.max(-pos.cost, pnl);

        pos.exitPrice = pos.entryPrice * (1 + pnlPercent / 100);
        pos.pnl = clampedPnl;
        pos.pnlPercent = pnlPercent;
        pos.status = 'closed';
        pos.closeTime = Date.now();
        pos.closeReason = isWin ? '止盈' : '止损';

        this.closedTrades.push(pos);
        this.tradeCount++;
        this.totalPnl += clampedPnl;
        this.dailyPnl += clampedPnl;
        if (clampedPnl > 0) this.winningTrades++;
        this.paperBalance = Math.max(0, this.paperBalance + pos.cost + clampedPnl);

        positionsToClose.push(pos);
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

  getState(): CopyTradingState {
    return {
      running: this.running,
      paperBalance: this.paperBalance,
      trackedWallets: this.trackedWallets.length,
      profitableWallets: this.trackedWallets.filter(w => w.winRate >= this.minWalletWinRate && w.totalPnl >= this.minWalletProfit).length,
      totalPnl: this.totalPnl,
      dailyPnl: this.dailyPnl,
      winRate: this.tradeCount > 0 ? (this.winningTrades / this.tradeCount) * 100 : 0,
      tradeCount: this.tradeCount,
      scanCount: this.scanCount,
      skipCount: this.skipCount,
      startTime: this.startTime,
      openPositions: this.openPositions,
      closedTrades: this.closedTrades.slice(-50),
      topWallets: this.trackedWallets.slice(0, 5),
    };
  }

  isRunning(): boolean { return this.running; }
  getPaperBalance(): number { return this.paperBalance; }
  getOpenPositions(): CopyTrade[] { return this.openPositions; }
  getClosedTrades(): CopyTrade[] { return this.closedTrades.slice(-50); }
}
