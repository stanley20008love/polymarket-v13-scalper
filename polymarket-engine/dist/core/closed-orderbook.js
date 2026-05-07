"use strict";
// ============================================================================
// Polymarket V13 - Closed Order Book Analyzer
// ============================================================================
// Marketing101 Module: Analyzes Polymarket order book data after market closure
// Extracts hidden liquidity patterns, whale positions, and maker bias
// This is the "exclusive data" advantage described in Marketing101 case study
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClosedOrderBookAnalyzer = void 0;
const logger_1 = require("../utils/logger");
class ClosedOrderBookAnalyzer {
    analyses = new Map();
    patterns = [];
    constructor() {
        this.initPatterns();
    }
    initPatterns() {
        this.patterns = [
            {
                pattern: 'WALL_ABOVE',
                description: 'Large sell wall above current price - resistance',
                signal: 'BEAR',
                strength: 0.7,
            },
            {
                pattern: 'WALL_BELOW',
                description: 'Large buy wall below current price - support',
                signal: 'BULL',
                strength: 0.7,
            },
            {
                pattern: 'SPOOF_LAYER',
                description: 'Thin orders that cancel before execution',
                signal: 'NEUTRAL',
                strength: 0.3,
            },
            {
                pattern: 'ICEBERG_BID',
                description: 'Hidden bid liquidity detected',
                signal: 'BULL',
                strength: 0.6,
            },
            {
                pattern: 'ICEBERG_ASK',
                description: 'Hidden ask liquidity detected',
                signal: 'BEAR',
                strength: 0.6,
            },
            {
                pattern: 'WHALE_ACCUMULATION',
                description: 'Large buyer building position gradually',
                signal: 'BULL',
                strength: 0.8,
            },
            {
                pattern: 'WHALE_DISTRIBUTION',
                description: 'Large seller exiting position gradually',
                signal: 'BEAR',
                strength: 0.8,
            },
        ];
    }
    /**
     * Analyze an order book for hidden patterns
     * Detects walls, iceberg orders, whale activity, and maker bias
     */
    analyzeOrderBook(conditionId, bids, asks, btcPrice, btcChange5m) {
        // Calculate basic metrics
        const totalBidLiquidity = bids.reduce((s, b) => s + b.size, 0);
        const totalAskLiquidity = asks.reduce((s, a) => s + a.size, 0);
        const bestBid = bids.length > 0 ? bids[0].price : 0;
        const bestAsk = asks.length > 0 ? asks[0].price : 1;
        // Detect whale orders (orders > 2x average size)
        const avgBidSize = bids.length > 0 ? totalBidLiquidity / bids.length : 0;
        const avgAskSize = asks.length > 0 ? totalAskLiquidity / asks.length : 0;
        const whaleThreshold = 2.0;
        const whaleBidCount = bids.filter(b => b.size > avgBidSize * whaleThreshold).length;
        const whaleAskCount = asks.filter(a => a.size > avgAskSize * whaleThreshold).length;
        // Maker bias: where is the "smart money" positioned?
        const makerBias = whaleBidCount > whaleAskCount + 2 ? 'YES'
            : whaleAskCount > whaleBidCount + 2 ? 'NO'
                : 'NEUTRAL';
        // Estimate hidden liquidity (iceberg orders)
        // If top-of-book sizes are disproportionately small vs deeper levels,
        // it suggests iceberg orders
        const topBidSize = bids.length > 0 ? bids[0].size : 0;
        const deepBidSize = bids.length > 3 ? bids.slice(1, 5).reduce((s, b) => s + b.size, 0) / 4 : 0;
        const icebergRatio = topBidSize > 0 && deepBidSize > 0 ? deepBidSize / topBidSize : 1;
        const hiddenLiquidity = icebergRatio > 2
            ? totalBidLiquidity * (icebergRatio - 1) * 0.3
            : 0;
        // Price efficiency: based on how balanced the book is
        // (For BTC-level order books, we use bid/ask balance instead of probability comparison)
        const totalLiquidity = totalBidLiquidity + totalAskLiquidity;
        const balanceRatio = totalLiquidity > 0
            ? Math.abs(totalBidLiquidity - totalAskLiquidity) / totalLiquidity
            : 0;
        const priceEfficiency = 1 - balanceRatio; // 1.0 = perfectly balanced, 0 = one-sided
        // Mispricing: based on depth imbalance (normalized to 0-100%)
        const mispricing = totalLiquidity > 0
            ? ((totalBidLiquidity - totalAskLiquidity) / totalLiquidity) * 100
            : 0;
        const analysis = {
            conditionId,
            finalYesPrice: bestAsk,
            finalNoPrice: 1 - bestBid,
            totalBidLiquidity,
            totalAskLiquidity,
            whaleBidCount,
            whaleAskCount,
            makerBias,
            hiddenLiquidity,
            priceEfficiency,
            mispricing,
            timestamp: Date.now(),
        };
        this.analyses.set(conditionId, analysis);
        logger_1.logger.info('Closed order book analysis', {
            conditionId: conditionId.substring(0, 12) + '...',
            makerBias,
            mispricing: mispricing.toFixed(3) + '%',
            whaleBids: whaleBidCount,
            whaleAsks: whaleAskCount,
            hiddenLiq: hiddenLiquidity.toFixed(2),
        });
        return analysis;
    }
    /**
     * Detect order book patterns
     */
    detectPatterns(bids, asks) {
        const detected = [];
        if (bids.length === 0 || asks.length === 0)
            return detected;
        const avgBidSize = bids.reduce((s, b) => s + b.size, 0) / bids.length;
        const avgAskSize = asks.reduce((s, a) => s + a.size, 0) / asks.length;
        // Detect sell walls
        const sellWalls = asks.filter(a => a.size > avgAskSize * 3);
        if (sellWalls.length > 0) {
            detected.push({
                pattern: 'WALL_ABOVE',
                description: `Sell wall at ${sellWalls[0].price.toFixed(4)} (${sellWalls[0].size.toFixed(0)} shares)`,
                signal: 'BEAR',
                strength: Math.min(1, sellWalls[0].size / (avgAskSize * 5)),
            });
        }
        // Detect buy walls
        const buyWalls = bids.filter(b => b.size > avgBidSize * 3);
        if (buyWalls.length > 0) {
            detected.push({
                pattern: 'WALL_BELOW',
                description: `Buy wall at ${buyWalls[0].price.toFixed(4)} (${buyWalls[0].size.toFixed(0)} shares)`,
                signal: 'BULL',
                strength: Math.min(1, buyWalls[0].size / (avgBidSize * 5)),
            });
        }
        // Detect potential iceberg (top level much smaller than average)
        if (bids.length > 0 && bids[0].size < avgBidSize * 0.3) {
            detected.push({
                pattern: 'ICEBERG_BID',
                description: 'Possible iceberg bid at top of book',
                signal: 'BULL',
                strength: 0.5,
            });
        }
        if (asks.length > 0 && asks[0].size < avgAskSize * 0.3) {
            detected.push({
                pattern: 'ICEBERG_ASK',
                description: 'Possible iceberg ask at top of book',
                signal: 'BEAR',
                strength: 0.5,
            });
        }
        // Detect whale accumulation (multiple large bids at different levels)
        const largeBids = bids.filter(b => b.size > avgBidSize * 2);
        if (largeBids.length >= 3) {
            detected.push({
                pattern: 'WHALE_ACCUMULATION',
                description: `${largeBids.length} large bids detected across levels`,
                signal: 'BULL',
                strength: Math.min(1, largeBids.length / 5),
            });
        }
        return detected;
    }
    /**
     * Get the latest analysis for a market
     */
    getAnalysis(conditionId) {
        return this.analyses.get(conditionId);
    }
    /**
     * Get all stored analyses
     */
    getAllAnalyses() {
        return Array.from(this.analyses.values());
    }
}
exports.ClosedOrderBookAnalyzer = ClosedOrderBookAnalyzer;
