// ============================================================================
// Polymarket V13 - Marketing101 Engine
// ============================================================================
// Based on the Marketing101 case study: Hong Kong marketer who made $374K/month
// Core System: Claude as algorithmic brain + MiroFish as simulation engine
// - 10,000 Monte Carlo simulation loops before each trade entry
// - Closed order book data + private OTC desk data
// - BTC price simulator with high precision (Jump-Diffusion + Mean Reversion)
// - Average $5,000-$15,000 per trade on Polymarket
// - NOT about guessing K-line direction - ENGINEERED profit through:
//   AI models, MiroFish simulation, exclusive data, and hardcore math

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

// Marketing101-specific types
export interface M101Signal {
  source: string;           // 'claude_brain' | 'mirofish' | 'otc' | 'closed_book' | 'btc_sim'
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  strength: number;         // 0-1
  confidence: number;       // 0-1
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

export interface M101State {
  running: boolean;
  btcPrice: number;
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
}

export class Marketing101Engine {
  private config: StrategyConfig;
  private miroFish: MiroFishEngine;
  private btcSim: BtcSimulator;
  private otcEngine: OTCDataEngine;
  private closedBookAnalyzer: ClosedOrderBookAnalyzer;

  private running: boolean = false;
  private scanTimer: NodeJS.Timeout | null = null;
  private startTime: number = 0;

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

  // Paper balance for Marketing101 mode (starts at $1000 - higher capital)
  private paperBalance: number = 1000;
  // Target trade size: $5,000-$15,000 per trade
  private targetTradeSizeMin: number = 50;    // Min $50 in paper mode
  private targetTradeSizeMax: number = 150;   // Max $150 in paper mode

  constructor(config: StrategyConfig) {
    this.config = config;
    this.miroFish = new MiroFishEngine(config);
    this.btcSim = new BtcSimulator();
    this.otcEngine = new OTCDataEngine();
    this.closedBookAnalyzer = new ClosedOrderBookAnalyzer();
  }

  /**
   * Start the Marketing101 Engine
   */
  async start(btcPrice: number): Promise<void> {
    if (this.running) {
      logger.warn('Marketing101 engine already running');
      return;
    }

    this.running = true;
    this.startTime = Date.now();

    // Initialize BTC simulator with current price
    this.btcSim.updateMarketData(btcPrice, []);

    logger.info('Marketing101 Engine started', {
      targetTradeSize: `$${this.targetTradeSizeMin}-$${this.targetTradeSizeMax}`,
      paperBalance: this.paperBalance,
    });

    // Main analysis loop - runs every 10 seconds
    this.scanTimer = setInterval(async () => {
      if (this.running) {
        try {
          await this.runAnalysis(btcPrice);
        } catch (e: any) {
          logger.debug('Marketing101 scan error', { error: e.message });
        }
      }
    }, 10000);
  }

  /**
   * Stop the engine
   */
  stop(): void {
    this.running = false;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    logger.info('Marketing101 engine stopped');
  }

  /**
   * Update BTC price (called from external feed)
   */
  updateBtcPrice(price: number, klines: number[]): void {
    this.btcSim.updateMarketData(price, klines);
  }

  /**
   * Main analysis cycle - the core of Marketing101 strategy
   * 5-Source Signal Convergence with Claude Brain Integration
   */
  private async runAnalysis(btcPrice: number): Promise<M101Decision | null> {
    this.scanCount++;

    const signals: M101Signal[] = [];
    const now = Date.now();

    // ===== Source 1: BTC Price Simulator (10K paths) =====
    const btcSimResult = this.runBtcSimulation(btcPrice);
    this.lastBtcSim = btcSimResult;

    signals.push({
      source: 'btc_sim',
      direction: btcSimResult.upCount > btcSimResult.downCount ? 'UP' : 'DOWN',
      strength: Math.abs(btcSimResult.upCount - btcSimResult.downCount) / 10000,
      confidence: Math.min(0.9, Math.abs(btcSimResult.avgFinalPrice - btcPrice) / btcPrice * 50),
      details: `10K paths: UP ${btcSimResult.upCount} | DOWN ${btcSimResult.downCount} | Avg: $${btcSimResult.avgFinalPrice.toFixed(0)} | P50: $${btcSimResult.p50.toFixed(0)}`,
      timestamp: now,
    });

    // ===== Source 2: OTC Desk Data =====
    const otcSnapshot = this.otcEngine.getSnapshot(btcPrice, 0);
    this.lastOtcSnapshot = otcSnapshot;

    signals.push({
      source: 'otc',
      direction: otcSnapshot.signal === 'BULL' ? 'UP' : otcSnapshot.signal === 'BEAR' ? 'DOWN' : 'NEUTRAL',
      strength: otcSnapshot.signalStrength,
      confidence: otcSnapshot.confidence,
      details: `Net Flow: ${otcSnapshot.netFlow.toFixed(1)} BTC | Buy: ${otcSnapshot.buyFlow.toFixed(1)} | Sell: ${otcSnapshot.sellFlow.toFixed(1)} | ${otcSnapshot.largeBlocks.length} large blocks`,
      timestamp: now,
    });

    // ===== Source 3: Claude Brain (AI Analysis) =====
    const claudeSignal = this.runClaudeBrainAnalysis(btcPrice, btcSimResult, otcSnapshot);
    signals.push(claudeSignal);

    // ===== Source 4: MiroFish Monte Carlo (10K loops) =====
    // Run MiroFish simulation with synthetic market/orderbook
    const synthOrderBook = this.btcSim.generateOrderBook(btcPrice);
    const synthMarket: Market = {
      conditionId: 'btc-5min-simulated',
      questionId: 'sim',
      question: 'Will BTC go UP or DOWN in 5 minutes?',
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
      0,  // btcChange5m - will be filled by caller
      0,  // btcVolume5m
      synthOrderBook.depthImbalance,
      [], // klines
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
      details: `10K sims: ${miroFishResult.direction} (${(miroFishResult.confidence).toFixed(1)}%) | Kelly: ${(miroFishResult.kellyFraction * 100).toFixed(2)}% | Sharpe: ${miroFishResult.sharpe.toFixed(3)} | Trade: ${miroFishResult.shouldTrade ? 'YES' : 'NO'}`,
      timestamp: now,
    });

    // ===== Source 5: Closed Order Book Analysis =====
    const closedBookAnalysis = this.closedBookAnalyzer.analyzeOrderBook(
      'btc-5min-simulated',
      synthOrderBook.bids,
      synthOrderBook.asks,
      btcPrice,
      0
    );
    this.lastClosedBook = closedBookAnalysis;

    signals.push({
      source: 'closed_book',
      direction: closedBookAnalysis.makerBias === 'YES' ? 'UP' : closedBookAnalysis.makerBias === 'NO' ? 'DOWN' : 'NEUTRAL',
      strength: Math.abs(closedBookAnalysis.mispricing) / 10,
      confidence: closedBookAnalysis.priceEfficiency,
      details: `Maker: ${closedBookAnalysis.makerBias} | Mispricing: ${closedBookAnalysis.mispricing.toFixed(3)}% | Whales: ${closedBookAnalysis.whaleBidCount}B/${closedBookAnalysis.whaleAskCount}A | Hidden: ${closedBookAnalysis.hiddenLiquidity.toFixed(1)}`,
      timestamp: now,
    });

    this.lastSignals = signals;

    // ===== CONVERGENCE: All 5 sources must agree =====
    const decision = this.makeDecision(signals, btcPrice, miroFishResult, otcSnapshot, closedBookAnalysis, btcSimResult);
    this.lastDecision = decision;

    if (decision.shouldTrade) {
      logger.info('Marketing101 SIGNAL', {
        direction: decision.direction,
        confidence: (decision.confidence * 100).toFixed(1) + '%',
        size: '$' + decision.positionSize.toFixed(2),
        ev: '$' + decision.expectedValue.toFixed(4),
        rr: decision.riskReward.toFixed(2),
      });
    } else {
      this.skipCount++;
    }

    return decision;
  }

  /**
   * Claude Brain Analysis - AI-driven market interpretation
   * This simulates what Claude would analyze as the "algorithmic brain"
   */
  private runClaudeBrainAnalysis(
    btcPrice: number,
    btcSim: BtcSimResult,
    otc: OTCDeskSnapshot
  ): M101Signal {
    // Claude Brain combines multiple perspectives:
    // 1. BTC price path distribution analysis
    // 2. OTC flow pattern recognition
    // 3. Cross-market correlation check
    // 4. Regime detection (trending vs mean-reverting)

    const upProb = btcSim.upCount / 10000;
    const downProb = btcSim.downCount / 10000;

    // Regime detection based on OTC flow
    let regime = 'NEUTRAL';
    let regimeStrength = 0;
    if (otc.netFlow > 50 && otc.signal === 'BULL') {
      regime = 'TRENDING_UP';
      regimeStrength = Math.min(1, otc.netFlow / 200);
    } else if (otc.netFlow < -50 && otc.signal === 'BEAR') {
      regime = 'TRENDING_DOWN';
      regimeStrength = Math.min(1, Math.abs(otc.netFlow) / 200);
    } else if (Math.abs(otc.netFlow) < 20) {
      regime = 'MEAN_REVERTING';
      regimeStrength = 0.5;
    }

    // Combine signals
    let direction: 'UP' | 'DOWN' | 'NEUTRAL' = 'NEUTRAL';
    let strength = 0;
    let confidence = 0.5;

    if (regime === 'TRENDING_UP' && upProb > 0.55) {
      direction = 'UP';
      strength = regimeStrength * 0.8 + (upProb - 0.5) * 1.5;
      confidence = 0.7 + regimeStrength * 0.2;
    } else if (regime === 'TRENDING_DOWN' && downProb > 0.55) {
      direction = 'DOWN';
      strength = regimeStrength * 0.8 + (downProb - 0.5) * 1.5;
      confidence = 0.7 + regimeStrength * 0.2;
    } else if (regime === 'MEAN_REVERTING') {
      // In mean-reverting regime, bet against recent move
      direction = upProb > 0.5 ? 'DOWN' : 'UP';
      strength = 0.3;
      confidence = 0.4;
    }

    return {
      source: 'claude_brain',
      direction,
      strength: Math.min(1, strength),
      confidence: Math.min(0.95, confidence),
      details: `Regime: ${regime} | ${direction} | OTC Net: ${otc.netFlow.toFixed(1)} BTC | Conf: ${(confidence * 100).toFixed(0)}%`,
      timestamp: Date.now(),
    };
  }

  /**
   * Run BTC price simulation (10K Monte Carlo paths)
   */
  private runBtcSimulation(btcPrice: number): BtcSimResult {
    const result = this.btcSim.runBatchSimulations(
      btcPrice,
      300,    // 5 minutes
      10000,  // 10K simulations
      5000    // 5-second steps
    );

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
   * Make trading decision based on all 5 signal sources
   * Requires 4/5 sources to agree (80% consensus) for trade execution
   */
  private makeDecision(
    signals: M101Signal[],
    btcPrice: number,
    simResult: any,
    otcSnapshot: OTCDeskSnapshot,
    closedBook: ClosedBookAnalysis,
    btcSim: BtcSimResult
  ): M101Decision {
    // Weighted vote across all sources
    let upScore = 0;
    let downScore = 0;
    let totalConfidence = 0;

    // Source weights: Claude Brain (30%), MiroFish (25%), BTC Sim (20%), OTC (15%), Closed Book (10%)
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

    // Count how many sources agree
    const agreeingSources = signals.filter(s => s.direction === direction).length;
    const consensusRatio = agreeingSources / signals.length;

    // Decision criteria:
    // 1. At least 4/5 sources must agree (80% consensus)
    // 2. Dominant score must be > 60% of total
    // 3. Average confidence must be > 50%
    // 4. MiroFish must confirm (shouldTrade = true)
    const shouldTrade =
      consensusRatio >= 0.8 &&
      consensus >= 0.6 &&
      totalConfidence >= 0.5 &&
      simResult.shouldTrade;

    // Position sizing based on Kelly criterion from MiroFish
    const kellySize = simResult.kellyFraction * this.paperBalance;
    const positionSize = Math.min(
      this.targetTradeSizeMax,
      Math.max(this.targetTradeSizeMin, kellySize)
    );

    // Risk/reward calculation
    const expectedPnl = shouldTrade ? simResult.expectedPnl * positionSize : 0;
    const riskAmount = positionSize * 0.005; // 0.5% risk
    const rewardAmount = positionSize * 0.015; // 1.5% target
    const riskReward = riskAmount > 0 ? rewardAmount / riskAmount : 0;

    // Entry/exit prices (for UP direction)
    const entryPrice = direction === 'UP'
      ? btcSim.p50 / btcPrice
      : 1 - (btcSim.p50 / btcPrice);
    const stopLoss = entryPrice * 0.995;  // 0.5% stop
    const takeProfit = entryPrice * 1.015; // 1.5% target

    const reasoning = shouldTrade
      ? `${direction} signal: ${agreeingSources}/5 sources agree (${(consensusRatio * 100).toFixed(0)}%) | Claude Brain + MiroFish + BTC Sim confirm | Consensus: ${(consensus * 100).toFixed(1)}% | Kelly: ${(simResult.kellyFraction * 100).toFixed(2)}% | RR: ${riskReward.toFixed(2)}`
      : `SKIP: Only ${agreeingSources}/5 sources agree (${(consensusRatio * 100).toFixed(0)}%) | Need 4/5 (80%) | Consensus: ${(consensus * 100).toFixed(1)}%`;

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

  // ---- Public Getters ----

  getState(): M101State {
    return {
      running: this.running,
      btcPrice: 0, // Filled by caller
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
    };
  }

  isRunning(): boolean { return this.running; }

  getPaperBalance(): number { return this.paperBalance; }

  recordTrade(pnl: number): void {
    this.tradeCount++;
    this.totalPnl += pnl;
    this.dailyPnl += pnl;
    if (pnl > 0) this.winningTrades++;
    this.paperBalance += pnl;
  }
}
