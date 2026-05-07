// ============================================================================
// Polymarket V11 Strategy Engine - Strategy Engine (Main Orchestrator)
// ============================================================================
// Combines EV Calculator + Risk Manager + Client into a cohesive trading loop

import { StrategyConfig } from './config';
import { EVCalculator } from './ev-calculator';
import { RiskManager } from './risk-manager';
import { PolymarketClient } from '../services/polymarket-client';
import {
  Market,
  OrderBook,
  Position,
  ScanResult,
  TradeRecord,
  TradeSignal,
  EngineState,
} from './types';
import { logger } from '../utils/logger';

export class StrategyEngine {
  private config: StrategyConfig;
  private evCalculator: EVCalculator;
  private riskManager: RiskManager;
  private client: PolymarketClient;
  private positions: Map<string, Position>;
  private tradeHistory: TradeRecord[];
  private running: boolean;
  private scanInterval: NodeJS.Timeout | null;
  private monitorInterval: NodeJS.Timeout | null;

  constructor(config: StrategyConfig) {
    this.config = config;
    this.evCalculator = new EVCalculator(config);
    this.riskManager = new RiskManager(config);
    this.client = new PolymarketClient(config);
    this.positions = new Map();
    this.tradeHistory = [];
    this.running = false;
    this.scanInterval = null;
    this.monitorInterval = null;
  }

  /**
   * Start the engine in specified mode
   */
  async start(mode: 'scan' | 'trade' | 'monitor'): Promise<void> {
    if (this.running) {
      logger.warn('Engine already running');
      return;
    }

    this.running = true;
    logger.info(`Starting V11 Strategy Engine in ${mode} mode`);

    // Check wallet balance
    const balance = await this.client.getWalletBalance();
    logger.info('Wallet balance', {
      tradingWallet: this.config.tradingWallet,
      usdc: balance.usdc.toFixed(2),
      usdcNative: balance.usdcNative.toFixed(2),
      pol: balance.pol.toFixed(6),
    });

    if (balance.totalUsd < 1) {
      logger.warn('Wallet balance too low for trading. Deposit USDC to proceed.');
    }

    switch (mode) {
      case 'scan':
        await this.startScanMode();
        break;
      case 'trade':
        await this.startTradeMode();
        break;
      case 'monitor':
        await this.startMonitorMode();
        break;
    }
  }

  /**
   * Stop the engine
   */
  stop(): void {
    this.running = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.client.closeWebSocket();
    logger.info('Engine stopped');
  }

  /**
   * Scan mode: Discover and evaluate markets without trading
   */
  private async startScanMode(): Promise<void> {
    logger.info('Starting scan mode - evaluating markets every 5 minutes');

    // Initial scan
    await this.scanMarkets();

    // Periodic scan
    this.scanInterval = setInterval(async () => {
      if (this.running) {
        await this.scanMarkets();
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Trade mode: Scan + execute trades
   */
  private async startTradeMode(): Promise<void> {
    logger.info('Starting trade mode - scanning and executing trades');

    // Start monitoring positions
    this.startPositionMonitor();

    // Main trading loop
    this.scanInterval = setInterval(async () => {
      if (this.running) {
        await this.scanAndTrade();
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Monitor mode: Only monitor existing positions for SL/TP
   */
  private async startMonitorMode(): Promise<void> {
    logger.info('Starting monitor mode - watching positions for SL/TP');
    this.startPositionMonitor();
  }

  /**
   * Scan all markets and evaluate
   */
  async scanMarkets(): Promise<ScanResult[]> {
    logger.info('Scanning markets...');
    const markets = await this.client.getMarkets({ active: true, closed: false, limit: 200 });
    const results: ScanResult[] = [];

    for (const market of markets) {
      try {
        // Get order book for first outcome token
        const tokenId = market.clobTokenIds?.[0];
        if (!tokenId) continue;

        const orderBook = await this.client.getOrderBook(tokenId);
        if (orderBook.bids.length === 0 && orderBook.asks.length === 0) continue;

        // Evaluate
        const balance = await this.client.getWalletBalance();
        const evaluation = this.evCalculator.evaluateMarket(market, orderBook, balance.totalUsd);

        // Check manipulation
        const midPrice = orderBook.asks.length > 0 && orderBook.bids.length > 0
          ? (orderBook.asks[0].price + orderBook.bids[0].price) / 2
          : 0;
        const manipCheck = this.riskManager.checkManipulation(market.conditionId, midPrice);

        const spread = orderBook.asks.length > 0 && orderBook.bids.length > 0
          ? ((orderBook.asks[0].price - orderBook.bids[0].price) / orderBook.asks[0].price) * 100
          : 100;

        const result: ScanResult = {
          market,
          orderBook,
          ev: evaluation.evCalc.ev,
          spread,
          liquidity: market.liquidity,
          pass: evaluation.signal === 'BUY' && !manipCheck.isManipulation,
          rejectReason: evaluation.signal === 'SKIP'
            ? evaluation.reason
            : manipCheck.isManipulation
              ? manipCheck.reason
              : undefined,
        };

        results.push(result);

        if (result.pass) {
          logger.info('✓ Market passed', {
            question: market.question?.substring(0, 60),
            ev: evaluation.evCalc.evPercent.toFixed(2) + '%',
            side: evaluation.side,
          });
        }
      } catch (error: any) {
        logger.debug('Error scanning market', {
          conditionId: market.conditionId,
          error: error.message,
        });
      }
    }

    const passed = results.filter(r => r.pass).length;
    logger.info(`Scan complete: ${passed}/${results.length} markets passed`);

    return results;
  }

  /**
   * Scan and execute trades
   */
  private async scanAndTrade(): Promise<void> {
    // Check rate limits
    const rateCheck = this.riskManager.canTrade();
    if (!rateCheck.allowed) {
      logger.info('Rate limited', { reason: rateCheck.reason });
      return;
    }

    const results = await this.scanMarkets();
    const opportunities = results.filter(r => r.pass);

    if (opportunities.length === 0) {
      logger.info('No trading opportunities found');
      return;
    }

    // Sort by EV descending
    opportunities.sort((a, b) => b.ev - a.ev);

    // Take top opportunity
    const best = opportunities[0];
    const balance = await this.client.getWalletBalance();

    if (balance.totalUsd < 1) {
      logger.warn('Insufficient balance for trading');
      return;
    }

    // Calculate position size
    const evaluation = this.evCalculator.evaluateMarket(
      best.market,
      best.orderBook,
      balance.totalUsd
    );

    const existingExposure = this.getExistingExposure(best.market.conditionId);
    const positionSize = this.riskManager.calculatePositionSize(
      balance.totalUsd,
      evaluation.evCalc.adjustedKellySize,
      existingExposure
    );

    if (positionSize < 1) {
      logger.info('Position size too small', { size: positionSize.toFixed(2) });
      return;
    }

    // Execute trade
    const tokenId = evaluation.side === 'YES'
      ? best.market.clobTokenIds[0]
      : best.market.clobTokenIds[1] || best.market.clobTokenIds[0];

    const bestAsk = best.orderBook.asks.length > 0 ? best.orderBook.asks[0].price : 0;
    const shares = positionSize / bestAsk;

    logger.info('Executing trade', {
      market: best.market.question?.substring(0, 60),
      side: evaluation.side,
      price: bestAsk,
      size: shares.toFixed(2),
      positionUsd: positionSize.toFixed(2),
      ev: evaluation.evCalc.evPercent.toFixed(2) + '%',
    });

    const result = await this.client.placeOrder({
      tokenId,
      side: 'BUY',
      price: bestAsk,
      size: Math.floor(shares),
    });

    if (result.success) {
      // Record position
      const position: Position = {
        conditionId: best.market.conditionId,
        tokenId,
        outcome: evaluation.side,
        entryPrice: bestAsk,
        currentPrice: bestAsk,
        size: shares,
        pnl: 0,
        pnlPercent: 0,
        entryTime: Date.now(),
        market: best.market,
      };
      this.positions.set(best.market.conditionId, position);

      // Record trade for rate limiting
      this.riskManager.recordTrade(0); // PnL will be updated later

      // Record trade history
      const trade: TradeRecord = {
        id: `trade-${Date.now()}`,
        conditionId: best.market.conditionId,
        side: 'BUY',
        outcome: evaluation.side,
        price: bestAsk,
        size: shares,
        ev: evaluation.evCalc.evPercent,
        pnl: 0,
        timestamp: Date.now(),
        orderId: result.orderId || '',
        reason: evaluation.reason,
      };
      this.tradeHistory.push(trade);

      logger.info('Trade executed successfully', {
        orderId: result.orderId,
        positionUsd: positionSize.toFixed(2),
      });
    } else {
      logger.error('Trade failed', { error: result.error });
    }
  }

  /**
   * Monitor positions for stop-loss and take-profit
   */
  private startPositionMonitor(): void {
    this.monitorInterval = setInterval(async () => {
      if (!this.running) return;

      for (const [conditionId, position] of this.positions) {
        try {
          // Get current price
          const orderBook = await this.client.getOrderBook(position.tokenId);
          if (orderBook.bids.length > 0) {
            position.currentPrice = orderBook.bids[0].price;
          }

          // Calculate PnL
          if (position.outcome === 'YES') {
            position.pnl = (position.currentPrice - position.entryPrice) * position.size;
            position.pnlPercent = ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100;
          } else {
            position.pnl = ((1 - position.currentPrice) - (1 - position.entryPrice)) * position.size;
            position.pnlPercent = ((1 - position.currentPrice) - (1 - position.entryPrice)) / (1 - position.entryPrice) * 100;
          }

          // Check SL/TP
          if (this.riskManager.shouldStopLoss(position)) {
            await this.closePosition(position, 'STOP_LOSS');
          } else if (this.riskManager.shouldTakeProfit(position)) {
            await this.closePosition(position, 'TAKE_PROFIT');
          }

          // Update manipulation check
          this.riskManager.checkManipulation(conditionId, position.currentPrice);

        } catch (error: any) {
          logger.debug('Error monitoring position', {
            conditionId,
            error: error.message,
          });
        }
      }
    }, 60 * 1000); // Every minute
  }

  /**
   * Close a position
   */
  private async closePosition(position: Position, reason: string): Promise<void> {
    logger.info(`Closing position: ${reason}`, {
      conditionId: position.conditionId,
      pnl: position.pnl.toFixed(4),
      pnlPercent: position.pnlPercent.toFixed(2),
    });

    const result = await this.client.placeOrder({
      tokenId: position.tokenId,
      side: 'SELL',
      price: position.currentPrice,
      size: position.size,
    });

    if (result.success) {
      this.riskManager.recordTrade(position.pnl);
      this.positions.delete(position.conditionId);

      // Record trade
      this.tradeHistory.push({
        id: `close-${Date.now()}`,
        conditionId: position.conditionId,
        side: 'SELL',
        outcome: position.outcome,
        price: position.currentPrice,
        size: position.size,
        ev: 0,
        pnl: position.pnl,
        timestamp: Date.now(),
        orderId: result.orderId || '',
        reason,
      });

      // Profit recovery: if profit, send to recovery wallet
      if (position.pnl > 5) {
        logger.info('Initiating profit recovery', { amount: position.pnl.toFixed(2) });
        await this.client.recoverProfits(position.pnl * 0.8); // Recover 80% of profit
      }
    } else {
      logger.error('Failed to close position', { error: result.error });
    }
  }

  /**
   * Get existing exposure for a market
   */
  private getExistingExposure(conditionId: string): number {
    const position = this.positions.get(conditionId);
    if (!position) return 0;
    return position.entryPrice * position.size;
  }

  /**
   * Get engine state
   */
  getState(): EngineState {
    return {
      running: this.running,
      mode: this.scanInterval ? 'scan' : this.monitorInterval ? 'monitor' : 'trade',
      positions: this.positions,
      rateLimit: {
        hourlyTrades: this.riskManager.getRiskState().hourlyTrades,
        hourlyResetTime: Date.now() + 3600000,
        dailyPnl: this.riskManager.getRiskState().dailyPnl,
        dailyResetTime: Date.now() + 86400000,
      },
      manipulationPauses: new Map(),
      lastScanTime: Date.now(),
      totalPnl: this.tradeHistory.reduce((sum, t) => sum + t.pnl, 0),
      dailyPnl: this.riskManager.getRiskState().dailyPnl,
      tradeHistory: this.tradeHistory,
    };
  }

  /**
   * Get trade history
   */
  getTradeHistory(): TradeRecord[] {
    return [...this.tradeHistory];
  }

  /**
   * Get all positions
   */
  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }
}
