"use strict";
// ============================================================================
// Polymarket V16 - Kelly Mean Reversion Engine
// ============================================================================
// Ported from DeepSeek Python bot: Kelly criterion + EMA(12) mean reversion
// 5-Source Signal Fusion: EMA Mean Reversion 40% + Volume 20% + Liquidity 15% + Kelly EV 15% + Overreaction 10%
// 1/4 Kelly fraction (ultra-conservative)
// Paper trading: $50 balance
Object.defineProperty(exports, "__esModule", { value: true });
exports.KellyEngine = void 0;
const mirofish_sim_1 = require("./mirofish-sim");
const btc_simulator_1 = require("./btc-simulator");
const otc_data_1 = require("./otc-data");
const closed_orderbook_1 = require("./closed-orderbook");
const logger_1 = require("../utils/logger");
class KellyEngine {
    config;
    miroFish;
    btcSim;
    otcEngine;
    closedBookAnalyzer;
    running = false;
    scanTimer = null;
    positionTimer = null;
    startTime = 0;
    // BTC price tracking
    currentBtcPrice = 0;
    priceHistory = [];
    emaPrice = 0;
    emaPeriod = 12; // EMA(12) from DeepSeek config
    // State
    lastDecision = null;
    lastSignals = [];
    // Stats
    tradeCount = 0;
    totalPnl = 0;
    dailyPnl = 0;
    dailyPnlResetTime = 0;
    winningTrades = 0;
    scanCount = 0;
    skipCount = 0;
    // Kelly stats
    kellyFractions = [];
    kellyFraction = 0.25; // 1/4 Kelly (ultra-conservative)
    // Paper trading: $50 balance
    paperBalance = 50;
    maxPositionSize = 10; // max $10 per trade (20% of capital)
    minPositionSize = 2; // min $2 per trade (4% of capital)
    // Position management
    openPositions = [];
    closedTrades = [];
    lastTradeTime = 0;
    // Risk controls
    maxOpenPositions = 3;
    dailyCapPercent = 5; // 5% daily max loss
    stopLossPercent = -50; // -50% stop loss
    takeProfitPercent = 100; // +100% take profit
    minTradeIntervalMs = 30000; // 30s between trades
    deviationThreshold = 0.05; // 5% deviation from EMA triggers signal
    // 5-Source weights
    SOURCE_WEIGHTS = {
        'ema_mean_reversion': 0.40,
        'volume': 0.20,
        'liquidity': 0.15,
        'kelly_ev': 0.15,
        'overreaction': 0.10,
    };
    constructor(config) {
        this.config = config;
        this.miroFish = new mirofish_sim_1.MiroFishEngine(config);
        this.btcSim = new btc_simulator_1.BtcSimulator();
        this.otcEngine = new otc_data_1.OTCDataEngine();
        this.closedBookAnalyzer = new closed_orderbook_1.ClosedOrderBookAnalyzer();
        this.dailyPnlResetTime = this.getNextDayStart();
    }
    async start(btcPrice) {
        if (this.running)
            return;
        this.running = true;
        this.startTime = Date.now();
        this.currentBtcPrice = btcPrice;
        this.emaPrice = btcPrice; // Initialize EMA at current price
        this.priceHistory = [btcPrice];
        this.btcSim.updateMarketData(btcPrice, []);
        logger_1.logger.info('Kelly引擎启动 (50U模拟盘, 1/4 Kelly)', {
            kellyFraction: this.kellyFraction,
            emaPeriod: this.emaPeriod,
            deviationThreshold: this.deviationThreshold,
            初始资金: `$${this.paperBalance}`,
        });
        // Main analysis loop - every 30 seconds
        this.scanTimer = setInterval(async () => {
            if (this.running) {
                try {
                    await this.runAnalysis(this.currentBtcPrice);
                }
                catch (e) {
                    logger_1.logger.debug('Kelly扫描错误', { error: e.message });
                }
            }
        }, 30000);
        // Position monitor - every 10 seconds
        this.positionTimer = setInterval(() => {
            if (this.running) {
                this.monitorPositions();
            }
        }, 10000);
    }
    stop() {
        this.running = false;
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        if (this.positionTimer) {
            clearInterval(this.positionTimer);
            this.positionTimer = null;
        }
        logger_1.logger.info('Kelly引擎已停止');
    }
    updateBtcPrice(price) {
        this.currentBtcPrice = price;
        this.updateEMA(price);
        this.btcSim.updateMarketData(price, this.priceHistory.slice(-20));
    }
    // ---- EMA Calculation ----
    updateEMA(price) {
        this.priceHistory.push(price);
        if (this.priceHistory.length > 200)
            this.priceHistory.shift();
        if (this.emaPrice === 0) {
            this.emaPrice = price;
        }
        else {
            const multiplier = 2 / (this.emaPeriod + 1);
            this.emaPrice = price * multiplier + this.emaPrice * (1 - multiplier);
        }
    }
    // ---- 5-Source Signal Fusion ----
    async runAnalysis(btcPrice) {
        this.scanCount++;
        this.resetDailyPnlIfNeeded();
        const signals = [];
        const now = Date.now();
        // ===== Signal 1: EMA Mean Reversion (40%) =====
        const deviation = this.emaPrice > 0
            ? (btcPrice - this.emaPrice) / this.emaPrice
            : 0;
        let emaDirection = 'NEUTRAL';
        let emaStrength = 0;
        let emaConfidence = 0.5;
        if (Math.abs(deviation) >= this.deviationThreshold) {
            // Mean reversion: if price is above EMA, bet it goes DOWN; if below, bet UP
            emaDirection = deviation > 0 ? 'DOWN' : 'UP';
            emaStrength = Math.min(1, Math.abs(deviation) / 0.15); // Scale: 5% deviation = 0.33, 15% = 1.0
            emaConfidence = Math.min(0.95, 0.5 + Math.abs(deviation) * 5);
        }
        signals.push({
            source: 'ema_mean_reversion',
            direction: emaDirection,
            strength: emaStrength,
            confidence: emaConfidence,
            details: `EMA(${this.emaPeriod}): $${this.emaPrice.toFixed(0)} | 偏离: ${(deviation * 100).toFixed(2)}% | 方向: ${emaDirection}`,
            weight: this.SOURCE_WEIGHTS['ema_mean_reversion'],
            timestamp: now,
        });
        // ===== Signal 2: Volume (20%) =====
        const recentPrices = this.priceHistory.slice(-20);
        const avgVolume = recentPrices.length > 5 ? recentPrices.length : 10; // Proxy for volume
        const volumeRatio = recentPrices.length > 0 ? Math.min(2, this.priceHistory.length / avgVolume) : 1;
        const volDirection = deviation > 0 ? 'DOWN' : deviation < 0 ? 'UP' : 'NEUTRAL'; // Volume confirms mean reversion
        signals.push({
            source: 'volume',
            direction: volumeRatio > 1.3 ? volDirection : 'NEUTRAL',
            strength: Math.min(1, volumeRatio / 2),
            confidence: Math.min(0.8, volumeRatio * 0.4),
            details: `成交量比: ${volumeRatio.toFixed(2)}x | ${volumeRatio > 1.3 ? '放量确认' : '量能不足'}`,
            weight: this.SOURCE_WEIGHTS['volume'],
            timestamp: now,
        });
        // ===== Signal 3: Liquidity (15%) =====
        const synthOB = this.btcSim.generateOrderBook(btcPrice);
        const liqDirection = synthOB.depthImbalance > 0.1 ? 'UP'
            : synthOB.depthImbalance < -0.1 ? 'DOWN'
                : 'NEUTRAL';
        signals.push({
            source: 'liquidity',
            direction: liqDirection,
            strength: Math.min(1, Math.abs(synthOB.depthImbalance) * 3),
            confidence: Math.min(0.8, 0.3 + Math.abs(synthOB.depthImbalance)),
            details: `深度失衡: ${(synthOB.depthImbalance * 100).toFixed(1)}% | 买卖差: ${liqDirection}`,
            weight: this.SOURCE_WEIGHTS['liquidity'],
            timestamp: now,
        });
        // ===== Signal 4: Kelly EV (15%) =====
        // Calculate Kelly criterion: f* = (p*b - q) / b
        // With mean reversion probability estimate
        const reversionProb = Math.abs(deviation) >= this.deviationThreshold
            ? Math.min(0.7, 0.5 + Math.abs(deviation) * 3) // Higher deviation = higher reversion prob
            : 0.5;
        const b = 1; // Even odds payout
        const q = 1 - reversionProb;
        const fullKelly = b > 0 ? (reversionProb * b - q) / b : 0;
        const fractionalKelly = fullKelly * this.kellyFraction; // 1/4 Kelly
        this.kellyFractions.push(fractionalKelly);
        if (this.kellyFractions.length > 100)
            this.kellyFractions.shift();
        const kellyDirection = deviation > 0 ? 'DOWN' : deviation < 0 ? 'UP' : 'NEUTRAL';
        signals.push({
            source: 'kelly_ev',
            direction: fractionalKelly > 0 ? kellyDirection : 'NEUTRAL',
            strength: Math.min(1, fractionalKelly * 4),
            confidence: Math.min(0.9, reversionProb),
            details: `Kelly: ${(fractionalKelly * 100).toFixed(2)}% (1/4 of ${(fullKelly * 100).toFixed(1)}%) | 回归概率: ${(reversionProb * 100).toFixed(1)}%`,
            weight: this.SOURCE_WEIGHTS['kelly_ev'],
            timestamp: now,
        });
        // ===== Signal 5: Overreaction Detection (10%) =====
        let overreactionDirection = 'NEUTRAL';
        let overreactionStrength = 0;
        let overreactionConfidence = 0.3;
        if (this.priceHistory.length >= 10) {
            const recentChange = (btcPrice - this.priceHistory[this.priceHistory.length - 10]) / this.priceHistory[this.priceHistory.length - 10];
            if (Math.abs(recentChange) > 0.02) { // 2%+ in recent window = overreaction
                overreactionDirection = recentChange > 0 ? 'DOWN' : 'UP'; // Bet on reversal
                overreactionStrength = Math.min(1, Math.abs(recentChange) / 0.05);
                overreactionConfidence = Math.min(0.85, 0.4 + Math.abs(recentChange) * 10);
            }
        }
        signals.push({
            source: 'overreaction',
            direction: overreactionDirection,
            strength: overreactionStrength,
            confidence: overreactionConfidence,
            details: `过度反应: ${overreactionDirection !== 'NEUTRAL' ? `检测到 ${overreactionDirection} 反转信号` : '未检测到'}`,
            weight: this.SOURCE_WEIGHTS['overreaction'],
            timestamp: now,
        });
        this.lastSignals = signals;
        // ===== Decision =====
        const decision = this.makeDecision(signals, btcPrice, deviation, fractionalKelly);
        this.lastDecision = decision;
        if (decision.shouldTrade) {
            this.executeSimTrade(decision, btcPrice);
        }
        else {
            this.skipCount++;
        }
        return decision;
    }
    makeDecision(signals, btcPrice, deviation, kellyFraction) {
        // Weighted voting
        let upScore = 0;
        let downScore = 0;
        for (const signal of signals) {
            const score = signal.strength * signal.confidence * signal.weight;
            if (signal.direction === 'UP')
                upScore += score;
            else if (signal.direction === 'DOWN')
                downScore += score;
        }
        const direction = upScore > downScore ? 'UP' : 'DOWN';
        const dominantScore = Math.max(upScore, downScore);
        const totalScore = upScore + downScore;
        const consensus = totalScore > 0 ? dominantScore / totalScore : 0;
        // Need 3/5 sources agreeing (60% consensus) AND deviation >= threshold
        const agreeingSources = signals.filter(s => s.direction === direction).length;
        const shouldTrade = agreeingSources >= 3 &&
            Math.abs(deviation) >= this.deviationThreshold &&
            kellyFraction > 0;
        // Position sizing: Kelly fraction of capital
        const kellySize = kellyFraction * this.paperBalance;
        const positionSize = shouldTrade
            ? Math.min(this.maxPositionSize, Math.max(this.minPositionSize, kellySize))
            : 0;
        const reasoning = shouldTrade
            ? `${direction === 'UP' ? '看涨' : '看跌'}均值回归 | ${agreeingSources}/5源同意 (${(consensus * 100).toFixed(0)}%) | EMA偏离: ${(deviation * 100).toFixed(2)}% | Kelly: ${(kellyFraction * 100).toFixed(2)}%`
            : `跳过: ${agreeingSources}/5源同意 | 需3/5+偏离${(this.deviationThreshold * 100).toFixed(0)}%+ | EMA偏离: ${(deviation * 100).toFixed(2)}%`;
        return {
            shouldTrade,
            direction,
            positionSize,
            kellyFraction,
            emaPrice: this.emaPrice,
            deviation,
            signals,
            reasoning,
            timestamp: Date.now(),
        };
    }
    // ---- Trade Execution ----
    executeSimTrade(decision, btcPrice) {
        // Risk checks
        if (this.openPositions.length >= this.maxOpenPositions) {
            this.skipCount++;
            return;
        }
        if (Date.now() - this.lastTradeTime < this.minTradeIntervalMs) {
            this.skipCount++;
            return;
        }
        // Daily cap check
        this.resetDailyPnlIfNeeded();
        const dailyCap = this.paperBalance * (this.dailyCapPercent / 100);
        if (this.dailyPnl <= -dailyCap) {
            this.skipCount++;
            return;
        }
        // Balance check
        const size = decision.positionSize;
        if (size > this.paperBalance || size < this.minPositionSize) {
            this.skipCount++;
            return;
        }
        // Entry price: based on Polymarket probability estimation from deviation
        const entryPrice = Math.max(0.05, Math.min(0.95, 0.5 + decision.deviation));
        const trade = {
            id: `kelly-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            timestamp: Date.now(),
            direction: decision.direction,
            entryPrice,
            exitPrice: 0,
            size,
            cost: size,
            pnl: 0,
            pnlPercent: 0,
            status: 'open',
            btcEntryPrice: btcPrice,
            confidence: decision.signals.filter(s => s.direction === decision.direction).length / 5,
            emaAtEntry: this.emaPrice,
            deviationAtEntry: decision.deviation,
            kellyFraction: decision.kellyFraction,
        };
        this.openPositions.push(trade);
        this.paperBalance -= size;
        this.lastTradeTime = Date.now();
        logger_1.logger.info('🎯 Kelly模拟交易', {
            方向: decision.direction,
            金额: '$' + size.toFixed(2),
            EMA偏离: (decision.deviation * 100).toFixed(2) + '%',
            Kelly: (decision.kellyFraction * 100).toFixed(2) + '%',
            剩余资金: '$' + this.paperBalance.toFixed(2),
        });
    }
    // ---- Position Monitor ----
    monitorPositions() {
        if (this.currentBtcPrice <= 0 || this.emaPrice <= 0)
            return;
        const positionsToClose = [];
        for (const pos of this.openPositions) {
            // Calculate simulated PnL based on BTC price movement relative to EMA
            const btcChange = (this.currentBtcPrice - pos.btcEntryPrice) / pos.btcEntryPrice;
            let pnlPercent;
            if (pos.direction === 'UP') {
                // UP position profits when BTC goes up
                pnlPercent = btcChange * 100;
            }
            else {
                // DOWN position profits when BTC goes down
                pnlPercent = -btcChange * 100;
            }
            // Check stop loss (-50%)
            if (pnlPercent <= this.stopLossPercent) {
                this.closeTrade(pos, pnlPercent, '止损');
                positionsToClose.push(pos);
                continue;
            }
            // Check take profit (+100%)
            if (pnlPercent >= this.takeProfitPercent) {
                this.closeTrade(pos, pnlPercent, '止盈');
                positionsToClose.push(pos);
                continue;
            }
            // Mean reversion exit: if price has reverted to EMA, close position
            const currentDeviation = this.emaPrice > 0
                ? (this.currentBtcPrice - this.emaPrice) / this.emaPrice
                : 0;
            if (pos.direction === 'UP' && currentDeviation >= -0.01 && pos.deviationAtEntry < -this.deviationThreshold) {
                // Was betting UP on negative deviation, now deviation is near zero → mean reversion complete
                this.closeTrade(pos, pnlPercent, '均值回归完成');
                positionsToClose.push(pos);
                continue;
            }
            if (pos.direction === 'DOWN' && currentDeviation <= 0.01 && pos.deviationAtEntry > this.deviationThreshold) {
                this.closeTrade(pos, pnlPercent, '均值回归完成');
                positionsToClose.push(pos);
                continue;
            }
            // Timeout: close after 30 minutes
            if (Date.now() - pos.timestamp > 30 * 60 * 1000) {
                this.closeTrade(pos, pnlPercent, '超时平仓');
                positionsToClose.push(pos);
            }
        }
        // Remove closed positions
        for (const pos of positionsToClose) {
            const idx = this.openPositions.indexOf(pos);
            if (idx >= 0)
                this.openPositions.splice(idx, 1);
        }
        // Trim closed trades
        if (this.closedTrades.length > 200) {
            this.closedTrades = this.closedTrades.slice(-200);
        }
    }
    closeTrade(pos, pnlPercent, reason) {
        const pnl = pos.cost * (pnlPercent / 100);
        const clampedPnl = Math.max(-pos.cost, pnl); // Cannot lose more than cost
        pos.exitPrice = pos.entryPrice * (1 + pnlPercent / 100);
        pos.pnl = clampedPnl;
        pos.pnlPercent = pnlPercent;
        pos.status = 'closed';
        pos.closeTime = Date.now();
        pos.closeReason = reason;
        pos.btcExitPrice = this.currentBtcPrice;
        this.closedTrades.push(pos);
        this.tradeCount++;
        this.totalPnl += clampedPnl;
        this.dailyPnl += clampedPnl;
        if (clampedPnl > 0)
            this.winningTrades++;
        // Refund balance (cannot go below 0)
        this.paperBalance = Math.max(0, this.paperBalance + pos.cost + clampedPnl);
        logger_1.logger.info('📊 Kelly平仓', {
            原因: reason,
            方向: pos.direction,
            盈亏: (clampedPnl >= 0 ? '+' : '') + '$' + clampedPnl.toFixed(4),
            盈亏百分比: pnlPercent.toFixed(2) + '%',
            剩余资金: '$' + this.paperBalance.toFixed(2),
            胜率: this.tradeCount > 0 ? (this.winningTrades / this.tradeCount * 100).toFixed(1) + '%' : '0%',
        });
    }
    // ---- Daily PnL Reset ----
    getNextDayStart() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setUTCHours(tomorrow.getUTCHours() + 24);
        tomorrow.setUTCHours(0, 0, 0, 0);
        return tomorrow.getTime();
    }
    resetDailyPnlIfNeeded() {
        if (Date.now() >= this.dailyPnlResetTime) {
            this.dailyPnl = 0;
            this.dailyPnlResetTime = this.getNextDayStart();
        }
    }
    // ---- Public Interface ----
    getState() {
        return {
            running: this.running,
            btcPrice: this.currentBtcPrice,
            paperBalance: this.paperBalance,
            emaPrice: this.emaPrice,
            deviation: this.emaPrice > 0 ? (this.currentBtcPrice - this.emaPrice) / this.emaPrice : 0,
            lastDecision: this.lastDecision,
            lastSignals: this.lastSignals,
            tradeCount: this.tradeCount,
            totalPnl: this.totalPnl,
            dailyPnl: this.dailyPnl,
            winRate: this.tradeCount > 0 ? (this.winningTrades / this.tradeCount) * 100 : 0,
            scanCount: this.scanCount,
            skipCount: this.skipCount,
            startTime: this.startTime,
            openPositions: this.openPositions,
            closedTrades: this.closedTrades.slice(-50),
            kellyStats: {
                avgKellyFraction: this.kellyFractions.length > 0
                    ? this.kellyFractions.reduce((a, b) => a + b, 0) / this.kellyFractions.length : 0,
                maxKellyFraction: this.kellyFractions.length > 0 ? Math.max(...this.kellyFractions) : 0,
                totalTradesKelly: this.kellyFractions.length,
                conservativeFraction: this.kellyFraction,
            },
        };
    }
    isRunning() { return this.running; }
    getPaperBalance() { return this.paperBalance; }
    getOpenPositions() { return this.openPositions; }
    getClosedTrades() { return this.closedTrades.slice(-50); }
}
exports.KellyEngine = KellyEngine;
