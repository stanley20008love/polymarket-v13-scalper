// ============================================================================
// Polymarket V13 - Trade Store (In-Memory + JSON Persistence)
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { ScalperTrade, ScalperPosition } from '../core/types';
import { logger } from '../utils/logger';

const DATA_DIR = path.join(process.env.DATA_DIR || '/tmp', 'polymarket-data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');

export class TradeStore {
  private trades: ScalperTrade[] = [];
  private positions: Map<string, ScalperPosition> = new Map();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.loadData();
    this.startAutoSave();
  }

  // ---- Trades ----

  addTrade(trade: ScalperTrade): void {
    this.trades.push(trade);
    logger.info('Trade recorded', {
      id: trade.id,
      side: trade.side,
      type: trade.tradeType,
      price: trade.price,
      size: trade.size,
      pnl: trade.pnl.toFixed(4),
      lag: trade.polymarketLag.toFixed(3) + '%',
      paper: trade.isPaper,
    });
  }

  updateTrade(id: string, updates: Partial<ScalperTrade>): void {
    const idx = this.trades.findIndex(t => t.id === id);
    if (idx >= 0) {
      this.trades[idx] = { ...this.trades[idx], ...updates };
    }
  }

  getTrades(limit?: number): ScalperTrade[] {
    const sorted = [...this.trades].sort((a, b) => b.timestamp - a.timestamp);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  getOpenTrades(): ScalperTrade[] {
    return this.trades.filter(t => t.status === 'open');
  }

  // ---- Positions ----

  openPosition(position: ScalperPosition): void {
    this.positions.set(position.id, position);
    logger.info('Position opened', {
      id: position.id,
      type: position.tradeType,
      entryPrice: position.entryPrice,
      size: position.size,
      cost: position.cost.toFixed(2),
      btcPrice: position.btcEntryPrice.toFixed(2),
    });
  }

  closePosition(id: string, closePrice: number, pnl: number, pnlPercent: number): void {
    const pos = this.positions.get(id);
    if (pos) {
      pos.status = 'closed';
      pos.currentPrice = closePrice;
      pos.pnl = pnl;
      pos.pnlPercent = pnlPercent;
      this.positions.delete(id);

      // Update corresponding trade
      const trade = this.trades.find(t => t.conditionId === pos.conditionId && t.status === 'open');
      if (trade) {
        trade.status = 'closed';
        trade.closeTimestamp = Date.now();
        trade.closePrice = closePrice;
        trade.pnl = pnl;
        trade.pnlPercent = pnlPercent;
      }

      logger.info('Position closed', {
        id,
        type: pos.tradeType,
        pnl: pnl.toFixed(4),
        pnlPercent: pnlPercent.toFixed(2) + '%',
      });
    }
  }

  updatePositionPrice(id: string, currentPrice: number): void {
    const pos = this.positions.get(id);
    if (pos) {
      pos.currentPrice = currentPrice;
      if (pos.entryPrice > 0) {
        pos.pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.pnl = pos.pnlPercent / 100 * pos.cost;
      }
    }
  }

  getOpenPositions(): ScalperPosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'open');
  }

  getAllPositions(): ScalperPosition[] {
    return Array.from(this.positions.values());
  }

  // ---- Stats ----

  getTotalPnl(): number {
    return this.trades
      .filter(t => t.status === 'closed')
      .reduce((sum, t) => sum + t.pnl, 0);
  }

  getDailyPnl(): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const dayStart = startOfDay.getTime();

    return this.trades
      .filter(t => t.status === 'closed' && t.timestamp >= dayStart)
      .reduce((sum, t) => sum + t.pnl, 0);
  }

  getWinRate(): number {
    const closed = this.trades.filter(t => t.status === 'closed');
    if (closed.length === 0) return 0;
    const wins = closed.filter(t => t.pnl > 0).length;
    return (wins / closed.length) * 100;
  }

  getTotalTrades(): number {
    return this.trades.filter(t => t.status === 'closed').length;
  }

  getWinningTrades(): number {
    return this.trades.filter(t => t.status === 'closed' && t.pnl > 0).length;
  }

  getLosingTrades(): number {
    return this.trades.filter(t => t.status === 'closed' && t.pnl <= 0).length;
  }

  // ---- Persistence ----

  private loadData(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(TRADES_FILE)) {
        const data = fs.readFileSync(TRADES_FILE, 'utf8');
        this.trades = JSON.parse(data);
        logger.info('Loaded trades from disk', { count: this.trades.length });
      }

      if (fs.existsSync(POSITIONS_FILE)) {
        const data = fs.readFileSync(POSITIONS_FILE, 'utf8');
        const positions: ScalperPosition[] = JSON.parse(data);
        for (const pos of positions) {
          if (pos.status === 'open') {
            this.positions.set(pos.id, pos);
          }
        }
        logger.info('Loaded open positions from disk', { count: this.positions.size });
      }
    } catch (e: any) {
      logger.warn('Failed to load trade data', { error: e.message });
    }
  }

  private saveData(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      fs.writeFileSync(TRADES_FILE, JSON.stringify(this.trades, null, 2));
      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(Array.from(this.positions.values()), null, 2));
    } catch (e: any) {
      logger.debug('Failed to save trade data', { error: e.message });
    }
  }

  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      this.saveData();
    }, 30000); // Save every 30 seconds
  }

  save(): void {
    this.saveData();
  }

  destroy(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveData();
  }

  // ---- Export ----

  exportAll(): { trades: ScalperTrade[]; positions: ScalperPosition[]; stats: any } {
    return {
      trades: this.trades,
      positions: Array.from(this.positions.values()),
      stats: {
        totalPnl: this.getTotalPnl(),
        dailyPnl: this.getDailyPnl(),
        winRate: this.getWinRate(),
        totalTrades: this.getTotalTrades(),
        winningTrades: this.getWinningTrades(),
        losingTrades: this.getLosingTrades(),
      },
    };
  }
}
