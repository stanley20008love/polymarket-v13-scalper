"use strict";
// ============================================================================
// Polymarket V11 Strategy Engine - EV Calculator
// ============================================================================
// Core EV calculation with Kelly Criterion position sizing
// Strategy: EV > 5%, Yes < 0.2 skip, Half-Kelly, 10% max position
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVCalculator = void 0;
const logger_1 = require("../utils/logger");
class EVCalculator {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Calculate Expected Value for a market
     *
     * EV = (TrueProb × Payout) - (1 - TrueProb) × Cost
     * For YES token: EV = TrueProb × (1 - Price) - (1 - TrueProb) × Price
     * For NO token: EV = (1 - TrueProb) × (1 - Price) - TrueProb × Price
     */
    calculateEV(market, orderBook, trueProbability, side) {
        const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0].price : 1;
        const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : 0;
        const midPrice = (bestAsk + bestBid) / 2;
        let impliedProb;
        let ev;
        let payout;
        let cost;
        if (side === 'YES') {
            impliedProb = midPrice;
            cost = bestAsk;
            payout = 1 - bestAsk;
            ev = (trueProbability * payout) - ((1 - trueProbability) * cost);
        }
        else {
            impliedProb = 1 - midPrice;
            cost = bestAsk;
            payout = 1 - bestAsk;
            ev = ((1 - trueProbability) * payout) - (trueProbability * cost);
        }
        const evPercent = (ev / cost) * 100;
        // Kelly Criterion: f* = (bp - q) / b
        // b = payout/cost ratio, p = trueProb, q = 1 - trueProb
        const b = payout / cost;
        const p = side === 'YES' ? trueProbability : (1 - trueProbability);
        const q = 1 - p;
        const fullKelly = (b * p - q) / b;
        const halfKelly = fullKelly * this.config.kellyFraction;
        const adjustedKelly = Math.min(halfKelly, this.config.maxPositionPercent / 100);
        const details = [
            `Side: ${side}`,
            `MidPrice: ${midPrice.toFixed(4)}`,
            `BestAsk: ${bestAsk.toFixed(4)}`,
            `ImpliedProb: ${(impliedProb * 100).toFixed(2)}%`,
            `TrueProb: ${(trueProbability * 100).toFixed(2)}%`,
            `EV: $${ev.toFixed(4)} (${evPercent.toFixed(2)}%)`,
            `FullKelly: ${(fullKelly * 100).toFixed(2)}%`,
            `HalfKelly: ${(halfKelly * 100).toFixed(2)}%`,
            `AdjustedKelly: ${(adjustedKelly * 100).toFixed(2)}%`,
        ].join(' | ');
        return {
            impliedProb,
            trueProb: trueProbability,
            ev,
            evPercent,
            kellySize: fullKelly,
            adjustedKellySize: adjustedKelly,
            details,
        };
    }
    /**
     * Estimate true probability using multiple signals
     * This is a simplified model - in production, integrate with:
     * - News sentiment analysis
     * - Historical resolution data
     * - Expert aggregation
     * - Manifold / Metaculus predictions
     */
    estimateTrueProbability(market, orderBook) {
        const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0].price : 0.5;
        const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : 0.5;
        const marketProb = (bestAsk + bestBid) / 2;
        // Base: Use market price as starting estimate
        // In production, override with ML model predictions
        let trueProb = marketProb;
        // Adjust for volume/liquidity signals
        if (market.volume > 100000) {
            // High volume markets tend to be more efficient
            trueProb = marketProb * 0.95 + 0.025;
        }
        // Clamp to [0.01, 0.99]
        trueProb = Math.max(0.01, Math.min(0.99, trueProb));
        return trueProb;
    }
    /**
     * Full market scan and evaluation
     */
    evaluateMarket(market, orderBook, walletBalance) {
        const trueProb = this.estimateTrueProbability(market, orderBook);
        // Evaluate both sides
        const yesCalc = this.calculateEV(market, orderBook, trueProb, 'YES');
        const noCalc = this.calculateEV(market, orderBook, trueProb, 'NO');
        // Pick the side with higher EV
        let bestCalc;
        let bestSide;
        if (yesCalc.ev > noCalc.ev) {
            bestCalc = yesCalc;
            bestSide = 'YES';
        }
        else {
            bestCalc = noCalc;
            bestSide = 'NO';
        }
        // ---- FILTER RULES ----
        // Rule 1: EV > 5%
        if (bestCalc.evPercent < this.config.minEvPercent) {
            return {
                signal: 'SKIP',
                side: bestSide,
                evCalc: bestCalc,
                reason: `EV ${bestCalc.evPercent.toFixed(2)}% < min ${this.config.minEvPercent}%`,
            };
        }
        // Rule 2: Yes < 0.2 → skip (avoid long-shot bias on YES side)
        if (bestSide === 'YES') {
            const yesPrice = orderBook.asks.length > 0 ? orderBook.asks[0].price : 1;
            if (yesPrice < this.config.maxYesPrice) {
                return {
                    signal: 'SKIP',
                    side: bestSide,
                    evCalc: bestCalc,
                    reason: `YES price ${yesPrice.toFixed(4)} < max ${this.config.maxYesPrice} (long-shot skip)`,
                };
            }
        }
        // Rule 3: Liquidity > $10k
        if (market.liquidity < this.config.minLiquidityUsd) {
            return {
                signal: 'SKIP',
                side: bestSide,
                evCalc: bestCalc,
                reason: `Liquidity $${market.liquidity.toFixed(0)} < min $${this.config.minLiquidityUsd}`,
            };
        }
        // Rule 4: Spread < 5%
        const bestAsk = orderBook.asks.length > 0 ? orderBook.asks[0].price : 1;
        const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : 0;
        const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 100 : 100;
        if (spread > this.config.maxSpreadPercent) {
            return {
                signal: 'SKIP',
                side: bestSide,
                evCalc: bestCalc,
                reason: `Spread ${spread.toFixed(2)}% > max ${this.config.maxSpreadPercent}%`,
            };
        }
        // Rule 5: Position size check
        const positionSize = walletBalance * bestCalc.adjustedKellySize;
        if (positionSize < 1) {
            return {
                signal: 'SKIP',
                side: bestSide,
                evCalc: bestCalc,
                reason: `Position size $${positionSize.toFixed(2)} too small`,
            };
        }
        logger_1.logger.info('Market passed evaluation', {
            question: market.question?.substring(0, 60),
            side: bestSide,
            evPercent: bestCalc.evPercent.toFixed(2),
            kellySize: (bestCalc.adjustedKellySize * 100).toFixed(2),
        });
        return {
            signal: 'BUY',
            side: bestSide,
            evCalc: bestCalc,
            reason: `EV ${bestCalc.evPercent.toFixed(2)}% | Kelly ${(bestCalc.adjustedKellySize * 100).toFixed(2)}% | Spread ${spread.toFixed(2)}%`,
        };
    }
}
exports.EVCalculator = EVCalculator;
