"use strict";
// ============================================================================
// Polymarket V13 - MiroFish Monte Carlo Simulation Engine
// ============================================================================
// Based on Marketing101 case study: 10,000 simulation loops per trade
// Simulates market reaction using multi-agent swarm intelligence
// Each loop: spawn agents → feed context → interact → measure outcome
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiroFishEngine = void 0;
const logger_1 = require("../utils/logger");
class MiroFishEngine {
    config;
    // Agent templates for BTC market simulation
    agentTemplates = [];
    // Simulation history for confidence calibration
    simulationHistory = [];
    constructor(config) {
        this.config = config;
        this.initAgentTemplates();
    }
    initAgentTemplates() {
        // Define agent archetypes that simulate real market participants
        this.agentTemplates = [
            // Momentum traders
            { type: 'momentum_trader', bias: 0, weight: 0.15, description: 'Follows price trends' },
            { type: 'momentum_trader', bias: 0, weight: 0.15, description: 'Follows volume spikes' },
            { type: 'momentum_trader', bias: 0, weight: 0.10, description: 'Crossover strategy' },
            // Market makers
            { type: 'market_maker', bias: 0, weight: 0.10, description: 'Provides liquidity on both sides' },
            { type: 'market_maker', bias: 0, weight: 0.08, description: 'Delta-neutral hedger' },
            // Contrarian / mean reversion
            { type: 'contrarian', bias: 0, weight: 0.08, description: 'Bets against extremes' },
            { type: 'contrarian', bias: 0, weight: 0.06, description: 'Mean reversion on RSI' },
            // OTC desk / institutional
            { type: 'otc_desk', bias: 0, weight: 0.08, description: 'Large block flow absorber' },
            { type: 'institutional', bias: 0, weight: 0.06, description: 'Algorithmic execution' },
            // Retail
            { type: 'retail_fomo', bias: 0.05, weight: 0.05, description: 'FOMO buyer at tops' },
            { type: 'retail_panic', bias: -0.05, weight: 0.05, description: 'Panic seller at bottoms' },
            // Whale
            { type: 'whale', bias: 0, weight: 0.04, description: 'Large position influencer' },
        ];
    }
    /**
     * Run Monte Carlo simulation with N loops
     * Each loop simulates the next 5 minutes of market behavior
     * Returns probability distribution and confidence metrics
     */
    async simulate(market, orderBook, btcPrice, btcChange5m, btcVolume5m, depthImbalance, klinesClose, loopCount = 10000) {
        const startTime = Date.now();
        logger_1.logger.info('MiroFish simulation starting', {
            market: market.question?.substring(0, 50),
            btcPrice,
            change5m: btcChange5m.toFixed(3) + '%',
            loops: loopCount,
        });
        // Phase 1: Build market context
        const context = this.buildMarketContext(btcPrice, btcChange5m, btcVolume5m, depthImbalance, klinesClose, orderBook, market);
        // Phase 2: Run simulation loops
        let upWins = 0;
        let downWins = 0;
        const pnlDistribution = [];
        const pricePaths = [];
        // Batch simulate for performance (can't actually spawn 10k LLM agents, use statistical model)
        for (let i = 0; i < loopCount; i++) {
            const result = this.runSingleLoop(context, i);
            if (result.direction === 'UP') {
                upWins++;
            }
            else {
                downWins++;
            }
            pnlDistribution.push(result.expectedPnl);
            if (i < 100) {
                pricePaths.push(result.pricePath);
            }
        }
        // Phase 3: Calculate statistics
        const upProb = upWins / loopCount;
        const downProb = downWins / loopCount;
        const avgPnl = pnlDistribution.reduce((a, b) => a + b, 0) / loopCount;
        const pnlStd = Math.sqrt(pnlDistribution.reduce((a, b) => a + (b - avgPnl) ** 2, 0) / loopCount);
        // Sort PnL distribution for percentile calculation
        const sortedPnl = [...pnlDistribution].sort((a, b) => a - b);
        const p5 = sortedPnl[Math.floor(loopCount * 0.05)];
        const p25 = sortedPnl[Math.floor(loopCount * 0.25)];
        const p50 = sortedPnl[Math.floor(loopCount * 0.50)];
        const p75 = sortedPnl[Math.floor(loopCount * 0.75)];
        const p95 = sortedPnl[Math.floor(loopCount * 0.95)];
        // Sharpe-like ratio
        const sharpe = pnlStd > 0 ? avgPnl / pnlStd : 0;
        // Kelly criterion based on simulation
        const winProb = Math.max(upProb, downProb);
        const loseProb = 1 - winProb;
        const avgWin = pnlDistribution.filter(p => p > 0).reduce((a, b) => a + b, 0) / (upWins + downWins || 1);
        const avgLoss = Math.abs(pnlDistribution.filter(p => p <= 0).reduce((a, b) => a + b, 0) / (loopCount - upWins - downWins || 1));
        const kellyFraction = avgLoss > 0 ? (winProb * avgWin - loseProb * avgLoss) / avgWin : 0;
        const halfKelly = kellyFraction * 0.5;
        // Direction
        const direction = upProb > downProb ? 'UP' : 'DOWN';
        const confidence = Math.abs(upProb - downProb) * 100; // How far from 50/50
        const elapsed = Date.now() - startTime;
        logger_1.logger.info('MiroFish simulation complete', {
            direction,
            upProb: (upProb * 100).toFixed(1) + '%',
            downProb: (downProb * 100).toFixed(1) + '%',
            confidence: confidence.toFixed(1) + '%',
            avgPnl: '$' + avgPnl.toFixed(4),
            sharpe: sharpe.toFixed(3),
            kelly: (halfKelly * 100).toFixed(2) + '%',
            elapsed: elapsed + 'ms',
            loops: loopCount,
        });
        return {
            direction,
            upProbability: upProb,
            downProbability: downProb,
            confidence,
            expectedPnl: avgPnl,
            pnlStdDev: pnlStd,
            sharpe,
            kellyFraction: halfKelly,
            pnlDistribution: { p5, p25, p50, p75, p95 },
            simulationCount: loopCount,
            elapsedMs: elapsed,
            pricePaths: pricePaths.slice(0, 20), // Top 20 paths for visualization
            shouldTrade: confidence >= 15 && halfKelly > 0.01, // Min 15% edge and positive Kelly
            marketContext: context.summary,
        };
    }
    /**
     * Build structured market context for simulation (like MiroFish seed packet)
     */
    buildMarketContext(btcPrice, btcChange5m, btcVolume5m, depthImbalance, klinesClose, orderBook, market) {
        // Calculate market microstructure metrics
        const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0].price : 0.5;
        const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : 0.5;
        const midPrice = (bestAsk + bestBid) / 2;
        const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 100 : 100;
        const askDepth = orderBook.asks.reduce((s, a) => s + a.size, 0);
        const bidDepth = orderBook.bids.reduce((s, b) => s + b.size, 0);
        const depthRatio = askDepth > 0 ? bidDepth / askDepth : 1;
        // Trend calculation from klines
        const trend = klinesClose.length >= 3
            ? (klinesClose[klinesClose.length - 1] - klinesClose[klinesClose.length - 3]) / klinesClose[klinesClose.length - 3]
            : 0;
        // Volatility from klines
        let volatility = 0;
        if (klinesClose.length >= 5) {
            const returns = [];
            for (let i = 1; i < klinesClose.length; i++) {
                if (klinesClose[i - 1] > 0) {
                    returns.push((klinesClose[i] - klinesClose[i - 1]) / klinesClose[i - 1]);
                }
            }
            if (returns.length > 0) {
                const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                volatility = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length);
            }
        }
        return {
            btcPrice,
            btcChange5m,
            btcVolume5m,
            depthImbalance,
            trend,
            volatility,
            midPrice,
            spread,
            depthRatio,
            klinesClose,
            summary: `BTC $${btcPrice.toFixed(0)} | 5m: ${btcChange5m >= 0 ? '+' : ''}${btcChange5m.toFixed(3)}% | Vol: $${(btcVolume5m / 1e6).toFixed(1)}M | Depth: ${(depthImbalance * 100).toFixed(0)}% | Spread: ${spread.toFixed(2)}% | Trend: ${(trend * 100).toFixed(3)}% | Vol: ${(volatility * 100).toFixed(3)}%`,
        };
    }
    /**
     * Run a single simulation loop
     * Models how different agent types would react to the current market state
     * Returns predicted direction and expected PnL
     */
    runSingleLoop(context, seed) {
        // Seeded random number generator for reproducibility within each loop
        let rng = this.seededRandom(seed + Date.now());
        // Simulate price path over 5 minutes (300 seconds in 30 steps)
        const steps = 30;
        const stepDuration = 10; // seconds per step
        let price = context.btcPrice;
        const pricePath = [price];
        // Base drift from current momentum
        const baseDrift = context.btcChange5m / 100 / steps; // Normalize to per-step
        // Volatility per step
        const stepVol = Math.max(context.volatility, 0.001) / Math.sqrt(steps);
        // Agent influence: each agent type votes on direction per step
        let bullPressure = 0;
        let bearPressure = 0;
        for (const agent of this.agentTemplates) {
            // Each agent generates a vote based on context + noise
            const vote = this.simulateAgentVote(agent, context, rng);
            if (vote > 0) {
                bullPressure += vote * agent.weight;
            }
            else {
                bearPressure += Math.abs(vote) * agent.weight;
            }
        }
        // Net directional pressure
        const netPressure = (bullPressure - bearPressure) / (bullPressure + bearPressure + 0.001);
        // Simulate price path using Geometric Brownian Motion with agent pressure
        for (let step = 0; step < steps; step++) {
            rng = this.seededRandom(seed * 31 + step * 17 + Date.now());
            const noise = (this.boxMullerRandom(rng) * stepVol);
            const drift = baseDrift * 0.3 + netPressure * stepVol * 0.5;
            const stepReturn = drift + noise;
            price = price * (1 + stepReturn);
            pricePath.push(price);
        }
        // Determine outcome: UP if final price > initial price
        const direction = pricePath[pricePath.length - 1] > context.btcPrice ? 'UP' : 'DOWN';
        // Expected PnL calculation
        const priceChange = (pricePath[pricePath.length - 1] - context.btcPrice) / context.btcPrice;
        const positionSize = 100 * 0.005; // 0.5% of $100
        const expectedPnl = direction === 'UP'
            ? positionSize * Math.max(0, priceChange * 100)
            : positionSize * Math.max(0, -priceChange * 100);
        return { direction, expectedPnl, pricePath };
    }
    /**
     * Simulate an individual agent's vote
     * Each agent type has different decision logic based on market context
     */
    simulateAgentVote(agent, context, rng) {
        const noise = (rng() - 0.5) * 0.3; // Random component [-0.15, 0.15]
        switch (agent.type) {
            case 'momentum_trader':
                // Follows trend - if BTC is going up, votes UP
                return Math.sign(context.btcChange5m) * Math.min(1, Math.abs(context.btcChange5m) * 20) + noise;
            case 'market_maker':
                // Neutral to slightly contrarian - provides liquidity, profits from spread
                return -Math.sign(context.btcChange5m) * 0.2 + noise;
            case 'contrarian':
                // Bets against extremes
                if (Math.abs(context.btcChange5m) > 0.3) {
                    return -Math.sign(context.btcChange5m) * 0.8 + noise;
                }
                return noise;
            case 'otc_desk':
                // Follows depth imbalance
                return context.depthImbalance * 2 + noise;
            case 'institutional':
                // Follows trend with delay (larger, slower)
                return Math.sign(context.trend) * 0.5 + noise;
            case 'retail_fomo':
                // FOMO: buys when already going up (positive feedback)
                if (context.btcChange5m > 0.1) {
                    return 0.8 + noise;
                }
                return noise;
            case 'retail_panic':
                // Panic: sells when going down (positive feedback)
                if (context.btcChange5m < -0.1) {
                    return -0.8 + noise;
                }
                return noise;
            case 'whale':
                // Whale: follows depth but can move market
                return context.depthImbalance * 1.5 + (rng() - 0.5) * 0.5;
            default:
                return noise;
        }
    }
    // ---- Utility Functions ----
    seededRandom(seed) {
        let s = Math.abs(seed) || 1;
        return () => {
            s = (s * 16807 + 0) % 2147483647;
            return (s - 1) / 2147483646;
        };
    }
    boxMullerRandom(rng) {
        const u1 = Math.max(1e-10, rng());
        const u2 = rng();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    // ---- Calibration ----
    recordOutcome(market, predictedDirection, actualOutcome) {
        const entry = this.simulationHistory.find(h => h.market === market && !h.actualOutcome);
        if (entry) {
            entry.actualOutcome = actualOutcome;
        }
        // Keep last 1000 records
        if (this.simulationHistory.length > 1000) {
            this.simulationHistory.shift();
        }
    }
    getCalibrationStats() {
        const withOutcome = this.simulationHistory.filter(h => h.actualOutcome);
        const correct = withOutcome.filter(h => h.predictedDirection === h.actualOutcome);
        return {
            totalPredictions: withOutcome.length,
            correctPredictions: correct.length,
            accuracy: withOutcome.length > 0 ? correct.length / withOutcome.length : 0,
            avgConfidence: withOutcome.length > 0
                ? withOutcome.reduce((s, h) => s + h.confidence, 0) / withOutcome.length
                : 0,
        };
    }
}
exports.MiroFishEngine = MiroFishEngine;
