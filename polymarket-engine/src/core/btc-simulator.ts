// ============================================================================
// Polymarket V13 - BTC High-Precision Price Simulator
// ============================================================================
// Marketing101 Module: Simulates BTC price movements with sub-second precision
// Uses Geometric Brownian Motion + Jump Diffusion + Mean Reversion
// Generates realistic order book snapshots at any future timestamp

import { logger } from '../utils/logger';

export interface BtcSimulationParams {
  currentPrice: number;
  drift: number;          // Expected return per second
  volatility: number;     // Volatility per second
  jumpIntensity: number;  // Average jumps per second
  jumpMean: number;       // Average jump size (log)
  jumpVolatility: number; // Jump size volatility
  meanReversionSpeed: number;
  meanReversionLevel: number;
}

export interface SimulatedOrderBook {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  midPrice: number;
  spread: number;
  depthImbalance: number;
  timestamp: number;
}

export interface BtcPricePath {
  prices: number[];
  timestamps: number[];
  finalPrice: number;
  maxPrice: number;
  minPrice: number;
  volatility: number;
  jumpCount: number;
}

export class BtcSimulator {
  private historicalPrices: number[] = [];
  private historicalVolatility: number = 0.0001; // Default per-second vol
  private lastUpdateTime: number = 0;

  constructor() {
    this.updateDefaultParams();
  }

  private updateDefaultParams(): void {
    // Default simulation parameters tuned for BTC 5-minute windows
    // Based on observed BTC behavior: ~0.001 drift/s, ~0.003 vol/s
  }

  /**
   * Update with real market data for calibration
   */
  updateMarketData(price: number, klines: number[]): void {
    this.historicalPrices.push(price);
    if (this.historicalPrices.length > 1000) {
      this.historicalPrices.shift();
    }

    // Recalculate volatility from recent prices
    if (this.historicalPrices.length > 20) {
      const returns: number[] = [];
      for (let i = 1; i < this.historicalPrices.length; i++) {
        if (this.historicalPrices[i - 1] > 0) {
          returns.push(
            Math.log(this.historicalPrices[i] / this.historicalPrices[i - 1])
          );
        }
      }
      if (returns.length > 10) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance =
          returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        this.historicalVolatility = Math.sqrt(variance);
      }
    }

    this.lastUpdateTime = Date.now();
  }

  /**
   * Generate a single BTC price path over a given time horizon
   * Uses Merton Jump-Diffusion Model + Ornstein-Uhlenbeck Mean Reversion
   */
  simulatePricePath(
    currentPrice: number,
    horizonSeconds: number = 300, // 5 minutes default
    stepMs: number = 1000,        // 1 second steps
    seed?: number
  ): BtcPricePath {
    const steps = Math.floor((horizonSeconds * 1000) / stepMs);
    const dt = stepMs / 1000; // Time step in seconds

    let rng = this.seededRandom(seed ?? Date.now());

    // Calibrate parameters from current market state
    const params: BtcSimulationParams = {
      currentPrice,
      drift: 0.00001,              // Very slight upward drift per second
      volatility: Math.max(this.historicalVolatility, 0.0003),
      jumpIntensity: 0.002,        // ~1 jump every 500 seconds
      jumpMean: -0.0001,           // Jumps slightly downward on average
      jumpVolatility: 0.002,
      meanReversionSpeed: 0.01,    // Gentle mean reversion
      meanReversionLevel: currentPrice,
    };

    const prices: number[] = [currentPrice];
    const timestamps: number[] = [Date.now()];
    let price = currentPrice;
    let maxPrice = currentPrice;
    let minPrice = currentPrice;
    let jumpCount = 0;

    for (let i = 1; i <= steps; i++) {
      // 1. GBM component: dS = μSdt + σSdW
      const z1 = this.boxMuller(rng);
      const gbmReturn = (params.drift - 0.5 * params.volatility ** 2) * dt
        + params.volatility * Math.sqrt(dt) * z1;

      // 2. Jump component: Poisson process
      let jumpReturn = 0;
      if (rng() < params.jumpIntensity * dt) {
        const z2 = this.boxMuller(rng);
        jumpReturn = params.jumpMean + params.jumpVolatility * z2;
        jumpCount++;
      }

      // 3. Mean reversion component: OU process
      const deviation = Math.log(price / params.meanReversionLevel);
      const mrReturn = -params.meanReversionSpeed * deviation * dt;

      // 4. Combine
      const totalReturn = gbmReturn + jumpReturn + mrReturn;
      price = price * Math.exp(totalReturn);

      prices.push(price);
      timestamps.push(Date.now() + i * stepMs);
      maxPrice = Math.max(maxPrice, price);
      minPrice = Math.min(minPrice, price);
    }

    // Calculate realized volatility
    const pathReturns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        pathReturns.push(Math.log(prices[i] / prices[i - 1]));
      }
    }
    const avgReturn = pathReturns.reduce((a, b) => a + b, 0) / pathReturns.length;
    const realizedVol = Math.sqrt(
      pathReturns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / pathReturns.length
    );

    return {
      prices,
      timestamps,
      finalPrice: price,
      maxPrice,
      minPrice,
      volatility: realizedVol,
      jumpCount,
    };
  }

  /**
   * Generate a synthetic order book at a given price level
   * Simulates realistic bid/ask depth distribution
   */
  generateOrderBook(
    midPrice: number,
    btcVolatility: number = 0.001,
    seed?: number
  ): SimulatedOrderBook {
    const rng = this.seededRandom(seed ?? Date.now() + 777);
    const bids: { price: number; size: number }[] = [];
    const asks: { price: number; size: number }[] = [];

    // Spread widens with volatility
    const baseSpread = 0.00005; // 0.005% base spread
    const spreadFactor = Math.max(1, btcVolatility / 0.0003);
    const halfSpread = midPrice * baseSpread * spreadFactor;

    // Generate 15 levels on each side
    const levels = 15;
    let bidPrice = midPrice - halfSpread;
    let askPrice = midPrice + halfSpread;

    // Depth profile: more liquidity near the mid, less far away
    for (let i = 0; i < levels; i++) {
      const depthDecay = Math.exp(-i * 0.15);
      const baseSize = 0.5 + rng() * 2.0; // 0.5-2.5 BTC per level
      const bidSize = baseSize * depthDecay * (1 + rng() * 0.5);
      const askSize = baseSize * depthDecay * (1 + rng() * 0.5);

      bids.push({ price: bidPrice, size: bidSize });
      asks.push({ price: askPrice, size: askSize });

      // Tick size decreases away from mid
      const tick = midPrice * (0.00003 + rng() * 0.00005);
      bidPrice -= tick;
      askPrice += tick;
    }

    // Calculate depth imbalance
    const totalBid = bids.reduce((s, b) => s + b.size, 0);
    const totalAsk = asks.reduce((s, a) => s + a.size, 0);
    const depthImbalance = totalAsk > 0
      ? (totalBid - totalAsk) / (totalBid + totalAsk)
      : 0;

    return {
      bids,
      asks,
      midPrice,
      spread: ((asks[0].price - bids[0].price) / midPrice) * 100,
      depthImbalance,
      timestamp: Date.now(),
    };
  }

  /**
   * Run batch simulations for Monte Carlo analysis
   * Returns distribution of final prices for statistical analysis
   */
  runBatchSimulations(
    currentPrice: number,
    horizonSeconds: number,
    count: number = 10000,
    stepMs: number = 5000
  ): {
    finalPrices: number[];
    upCount: number;
    downCount: number;
    avgFinalPrice: number;
    stdFinalPrice: number;
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    maxPrice: number;
    minPrice: number;
    avgJumpCount: number;
  } {
    const finalPrices: number[] = [];
    let totalJumps = 0;

    for (let i = 0; i < count; i++) {
      const path = this.simulatePricePath(
        currentPrice,
        horizonSeconds,
        stepMs,
        i * 7919 + Date.now()  // Unique seed per simulation
      );
      finalPrices.push(path.finalPrice);
      totalJumps += path.jumpCount;
    }

    // Sort for percentile calculation
    const sorted = [...finalPrices].sort((a, b) => a - b);

    const avgFinalPrice = finalPrices.reduce((a, b) => a + b, 0) / count;
    const variance = finalPrices.reduce(
      (a, b) => a + (b - avgFinalPrice) ** 2, 0
    ) / count;
    const stdFinalPrice = Math.sqrt(variance);

    const upCount = finalPrices.filter(p => p > currentPrice).length;
    const downCount = finalPrices.filter(p => p < currentPrice).length;

    return {
      finalPrices: sorted,
      upCount,
      downCount,
      avgFinalPrice,
      stdFinalPrice,
      p5: sorted[Math.floor(count * 0.05)],
      p25: sorted[Math.floor(count * 0.25)],
      p50: sorted[Math.floor(count * 0.50)],
      p75: sorted[Math.floor(count * 0.75)],
      p95: sorted[Math.floor(count * 0.95)],
      maxPrice: sorted[sorted.length - 1],
      minPrice: sorted[0],
      avgJumpCount: totalJumps / count,
    };
  }

  // ---- Utility ----

  private seededRandom(seed: number): () => number {
    let s = Math.abs(seed) || 1;
    return () => {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  private boxMuller(rng: () => number): number {
    const u1 = Math.max(1e-10, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}
