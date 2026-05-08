"use strict";
// ============================================================================
// Polymarket V13 - BTC 5MIN Scalper Engine
// ============================================================================
// Edge: Exploit Polymarket CLOB price lag vs Binance spot
// When BTC moves and Polymarket UP/DOWN 5MIN markets haven't re-priced → trade the lag
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScalperEngine = void 0;
const mirofish_sim_1 = require("./mirofish-sim");
const logger_1 = require("../utils/logger");
class ScalperEngine {
    config;
    binance;
    client;
    store;
    running = false;
    mode = 'idle';
    // BTC state
    btcPrice = 0;
    btcChange5m = 0;
    klines5m = [];
    // Polymarket 5MIN markets
    upMarkets = [];
    downMarkets = [];
    marketRefreshTimer = null;
    scanTimer = null;
    // Risk
    dailyPnl = 0;
    dailyCapUsed = 0;
    hardStopTriggered = false;
    tradeCountToday = 0;
    lastTradeTime = 0;
    // Stats
    scanCount = 0;
    skipCount = 0;
    startTime = 0;
    // Signals
    lastSignals = [];
    lastConvergence = null;
    lastSignalTime = 0;
    // MiroFish simulation
    miroFish;
    lastSimulation = null;
    simulationCount = 0;
    // Simulated balance for paper trading
    paperBalance = 50; // Start with $50 (50U)
    constructor(config, binance, client, store) {
        this.config = config;
        this.binance = binance;
        this.client = client;
        this.store = store;
        this.miroFish = new mirofish_sim_1.MiroFishEngine(config);
    }
    async start() {
        if (this.running) {
            logger_1.logger.warn('Scalper already running');
            return;
        }
        this.running = true;
        this.mode = this.config.scalperMode;
        this.startTime = Date.now();
        this.hardStopTriggered = false;
        logger_1.logger.info(`Starting V13 Scalper Engine in ${this.mode} mode`, {
            lagThreshold: this.config.lagThreshold + '%',
            perTradeRisk: this.config.perTradeRiskPercent + '%',
            dailyCap: this.config.dailyCapPercent + '%',
            hardStop: this.config.hardStopPercent + '%',
            minConvergence: this.config.minConvergence + '%',
        });
        // Set up Binance callbacks
        this.binance.setCallbacks((price, change5m) => {
            this.btcPrice = price;
            this.btcChange5m = change5m;
        }, (kline) => {
            if (kline.isFinal) {
                this.klines5m.push(kline);
                if (this.klines5m.length > 50)
                    this.klines5m.shift();
            }
        });
        // Connect to Binance
        try {
            await this.binance.connect();
            logger_1.logger.info('Binance feed connected', { btcPrice: this.binance.getPrice() });
        }
        catch (e) {
            logger_1.logger.error('Binance connection failed, using REST fallback', { error: e.message });
            // Fallback: fetch BTC price via REST
            await this.fetchBtcPriceRest();
        }
        // Find Polymarket UP/DOWN 5MIN markets
        await this.refreshMarkets();
        // Start periodic market refresh (every 2 minutes)
        this.marketRefreshTimer = setInterval(async () => {
            if (this.running) {
                try {
                    await this.refreshMarkets();
                }
                catch (e) {
                    logger_1.logger.debug('Market refresh error', { error: e.message });
                }
            }
        }, 2 * 60 * 1000);
        // Start main scan loop (every 5 seconds for fast detection)
        this.scanTimer = setInterval(async () => {
            if (this.running) {
                try {
                    await this.scanAndTrade();
                }
                catch (e) {
                    logger_1.logger.debug('Scan error', { error: e.message });
                }
            }
        }, 5000);
        logger_1.logger.info('Scalper engine started successfully');
    }
    stop() {
        this.running = false;
        this.mode = 'idle';
        if (this.marketRefreshTimer) {
            clearInterval(this.marketRefreshTimer);
            this.marketRefreshTimer = null;
        }
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
        this.binance.disconnect();
        this.store.save();
        logger_1.logger.info('Scalper engine stopped');
    }
    // ---- Market Discovery ----
    async refreshMarkets() {
        try {
            const markets = await this.client.getMarkets({ active: true, closed: false, limit: 200 });
            // Find BTC UP/DOWN 5-minute markets
            this.upMarkets = markets.filter(m => m.question?.toLowerCase().includes('btc') &&
                m.question?.toLowerCase().includes('up') &&
                (m.question?.toLowerCase().includes('5') || m.question?.toLowerCase().includes('minute')));
            this.downMarkets = markets.filter(m => m.question?.toLowerCase().includes('btc') &&
                m.question?.toLowerCase().includes('down') &&
                (m.question?.toLowerCase().includes('5') || m.question?.toLowerCase().includes('minute')));
            // Also look for broader BTC markets
            const btcMarkets = markets.filter(m => m.question?.toLowerCase().includes('bitcoin') ||
                m.question?.toLowerCase().includes('btc'));
            if (this.upMarkets.length === 0 && this.downMarkets.length === 0 && btcMarkets.length > 0) {
                // Use any BTC market as fallback
                logger_1.logger.info('Using broader BTC markets as fallback', { count: btcMarkets.length });
                this.upMarkets = btcMarkets.filter(m => m.question?.toLowerCase().includes('above') ||
                    m.question?.toLowerCase().includes('higher') ||
                    m.question?.toLowerCase().includes('up') ||
                    m.question?.toLowerCase().includes('rise'));
                this.downMarkets = btcMarkets.filter(m => m.question?.toLowerCase().includes('below') ||
                    m.question?.toLowerCase().includes('lower') ||
                    m.question?.toLowerCase().includes('down') ||
                    m.question?.toLowerCase().includes('drop') ||
                    m.question?.toLowerCase().includes('fall'));
            }
            logger_1.logger.info('Market refresh complete', {
                upMarkets: this.upMarkets.length,
                downMarkets: this.downMarkets.length,
                totalBTC: btcMarkets.length,
            });
        }
        catch (e) {
            logger_1.logger.error('Market refresh failed', { error: e.message });
        }
    }
    // ---- Core Strategy ----
    async scanAndTrade() {
        if (!this.running || this.hardStopTriggered)
            return;
        this.scanCount++;
        const btcPrice = this.binance.getPrice();
        if (btcPrice <= 0)
            return;
        // 1. Analyze signals
        const signals = this.analyzeSignals();
        this.lastSignals = signals;
        this.lastSignalTime = Date.now();
        // 2. Check signal convergence
        const convergence = this.checkConvergence(signals);
        this.lastConvergence = convergence;
        if (!convergence.shouldTrade) {
            this.skipCount++;
            return;
        }
        // 3. Risk checks
        if (!this.checkRisk()) {
            this.skipCount++;
            return;
        }
        // 4. Find the right market
        const targetMarket = convergence.tradeSide === 'UP'
            ? this.upMarkets[0]
            : this.downMarkets[0];
        if (!targetMarket) {
            logger_1.logger.debug('No matching market for signal', { side: convergence.tradeSide });
            this.skipCount++;
            return;
        }
        // 5. Get order book and check lag
        const tokenId = targetMarket.clobTokenIds?.[0];
        if (!tokenId)
            return;
        const orderBook = await this.client.getOrderBook(tokenId);
        if (orderBook.asks.length === 0) {
            this.skipCount++;
            return;
        }
        // 6. Calculate Polymarket implied probability
        const bestAsk = orderBook.asks[0].price;
        const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : 0;
        const midPrice = (bestAsk + bestBid) / 2;
        const spread = bestAsk > 0 ? ((bestAsk - bestBid) / bestAsk) * 100 : 100;
        // 7. Check if there's a lag
        const polymarketLag = convergence.tradeSide === 'UP'
            ? Math.max(0, convergence.strength * 100 - midPrice * 100)
            : Math.max(0, midPrice * 100 - (1 - convergence.strength) * 100);
        if (polymarketLag < this.config.lagThreshold) {
            this.skipCount++;
            return;
        }
        // 8. Run MiroFish Monte Carlo simulation (10K loops)
        const klinesClose = this.klines5m.map(k => k.close);
        const simResult = await this.miroFish.simulate(targetMarket, orderBook, btcPrice, this.btcChange5m, this.binance.getVolume5m(), this.binance.getDepthImbalance(), klinesClose, 10000);
        this.lastSimulation = simResult;
        this.simulationCount++;
        if (!simResult.shouldTrade) {
            logger_1.logger.info('MiroFish says SKIP', {
                direction: simResult.direction,
                confidence: simResult.confidence.toFixed(1) + '%',
            });
            this.skipCount++;
            return;
        }
        // Override trade side with MiroFish direction if it disagrees
        if (simResult.direction === 'DOWN' && convergence.tradeSide === 'UP') {
            convergence.tradeSide = 'DOWN';
            convergence.direction = 'BEAR';
        }
        else if (simResult.direction === 'UP' && convergence.tradeSide === 'DOWN') {
            convergence.tradeSide = 'UP';
            convergence.direction = 'BULL';
        }
        // 9. Execute trade
        await this.executeTrade(targetMarket, tokenId, orderBook, convergence, polymarketLag, btcPrice);
    }
    // ---- Signal Analysis (Force-Graph Convergence) ----
    analyzeSignals() {
        const signals = [];
        const price = this.binance.getPrice();
        const change5m = this.btcChange5m;
        // Signal 1: 5M Momentum
        const momentumDir = change5m > 0.05 ? 'BULL' : change5m < -0.05 ? 'BEAR' : 'NEUTRAL';
        signals.push({
            name: '5M Momentum',
            direction: momentumDir,
            strength: Math.min(1, Math.abs(change5m) / 0.5),
            weight: 0.25,
            details: `BTC ${change5m > 0 ? '+' : ''}${change5m.toFixed(3)}% in 5m`,
        });
        // Signal 2: Volume Profile
        const volume5m = this.binance.getVolume5m();
        const avgVolume = this.klines5m.length > 3
            ? this.klines5m.slice(-5).reduce((s, k) => s + k.volume, 0) / Math.min(5, this.klines5m.length)
            : volume5m;
        const volumeRatio = avgVolume > 0 ? volume5m / avgVolume : 1;
        signals.push({
            name: 'Volume Profile',
            direction: volumeRatio > 1.5 ? momentumDir : 'NEUTRAL',
            strength: Math.min(1, volumeRatio / 3),
            weight: 0.20,
            details: `5m Vol: $${(volume5m / 1000000).toFixed(1)}M (${volumeRatio.toFixed(1)}x avg)`,
        });
        // Signal 3: Order Flow (Depth Imbalance)
        const depthImbalance = this.binance.getDepthImbalance();
        const flowDir = depthImbalance > 0.1 ? 'BULL' : depthImbalance < -0.1 ? 'BEAR' : 'NEUTRAL';
        signals.push({
            name: 'Order Flow',
            direction: flowDir,
            strength: Math.min(1, Math.abs(depthImbalance) * 3),
            weight: 0.20,
            details: `Depth: ${(depthImbalance * 100).toFixed(1)}% ${flowDir}`,
        });
        // Signal 4: Kline Pattern
        const kline = this.binance.getCurrentKline();
        if (kline) {
            const bodySize = Math.abs(kline.close - kline.open);
            const wickSize = kline.high - kline.low;
            const isBullish = kline.close > kline.open;
            const bodyRatio = wickSize > 0 ? bodySize / wickSize : 0;
            let patternDir = 'NEUTRAL';
            let patternStrength = 0;
            if (bodyRatio > 0.6) {
                patternDir = isBullish ? 'BULL' : 'BEAR';
                patternStrength = bodyRatio;
            }
            signals.push({
                name: 'Kline Pattern',
                direction: patternDir,
                strength: Math.min(1, patternStrength),
                weight: 0.15,
                details: isBullish ? 'Bullish candle' : 'Bearish candle',
            });
        }
        else {
            signals.push({
                name: 'Kline Pattern',
                direction: 'NEUTRAL',
                strength: 0,
                weight: 0.15,
                details: 'No current kline',
            });
        }
        // Signal 5: Trend (3-candle trend)
        if (this.klines5m.length >= 3) {
            const recent = this.klines5m.slice(-3);
            const bullish = recent.filter(k => k.close > k.open).length;
            const bearish = recent.filter(k => k.close < k.open).length;
            const trendDir = bullish >= 2 ? 'BULL' : bearish >= 2 ? 'BEAR' : 'NEUTRAL';
            signals.push({
                name: '3-Candle Trend',
                direction: trendDir,
                strength: Math.max(bullish, bearish) / 3,
                weight: 0.20,
                details: `${bullish}B/${bearish}R in last 3 candles`,
            });
        }
        else {
            signals.push({
                name: '3-Candle Trend',
                direction: 'NEUTRAL',
                strength: 0,
                weight: 0.20,
                details: 'Insufficient kline data',
            });
        }
        return signals;
    }
    checkConvergence(signals) {
        // Weighted vote: each signal contributes direction * strength * weight
        let bullScore = 0;
        let bearScore = 0;
        let totalWeight = 0;
        for (const sig of signals) {
            if (sig.direction === 'BULL') {
                bullScore += sig.strength * sig.weight;
            }
            else if (sig.direction === 'BEAR') {
                bearScore += sig.strength * sig.weight;
            }
            totalWeight += sig.weight;
        }
        const maxScore = Math.max(bullScore, bearScore);
        const confidence = totalWeight > 0 ? (maxScore / totalWeight) * 100 : 0;
        const direction = bullScore > bearScore ? 'BULL' : bearScore > bullScore ? 'BEAR' : 'NEUTRAL';
        const strength = totalWeight > 0 ? maxScore / totalWeight : 0;
        const shouldTrade = direction !== 'NEUTRAL' && confidence >= this.config.minConvergence;
        const tradeSide = direction === 'BULL' ? 'UP' : direction === 'BEAR' ? 'DOWN' : null;
        return {
            direction,
            strength,
            confidence,
            signals,
            polymarketLag: 0, // Will be calculated later
            shouldTrade,
            tradeSide,
            details: `${direction} ${confidence.toFixed(0)}% | Bull: ${(bullScore * 100).toFixed(1)} Bear: ${(bearScore * 100).toFixed(1)}`,
        };
    }
    // ---- Risk Management ----
    checkRisk() {
        // Check hard stop
        if (this.hardStopTriggered)
            return false;
        // Check daily cap
        this.dailyPnl = this.store.getDailyPnl();
        this.dailyCapUsed = this.dailyPnl;
        const dailyCapAmount = this.mode === 'paper'
            ? this.paperBalance * (this.config.dailyCapPercent / 100)
            : 100 * (this.config.dailyCapPercent / 100);
        if (this.dailyPnl <= -dailyCapAmount) {
            logger_1.logger.warn('Daily cap reached', { dailyPnl: this.dailyPnl.toFixed(4), cap: dailyCapAmount.toFixed(2) });
            return false;
        }
        // Check hard stop
        const hardStopAmount = this.mode === 'paper'
            ? this.paperBalance * (this.config.hardStopPercent / 100)
            : 100 * (this.config.hardStopPercent / 100);
        if (this.dailyPnl <= -hardStopAmount) {
            this.hardStopTriggered = true;
            logger_1.logger.error('HARD STOP TRIGGERED', { dailyPnl: this.dailyPnl.toFixed(4) });
            return false;
        }
        // Check max active positions
        if (this.store.getOpenPositions().length >= this.config.maxActivePositions) {
            return false;
        }
        // Rate limit: min 10s between trades
        if (Date.now() - this.lastTradeTime < 10000) {
            return false;
        }
        return true;
    }
    // ---- Trade Execution ----
    async executeTrade(market, tokenId, orderBook, convergence, polymarketLag, btcPrice) {
        const bestAsk = orderBook.asks[0].price;
        const bestBid = orderBook.bids.length > 0 ? orderBook.bids[0].price : bestAsk * 0.95;
        const spread = ((bestAsk - bestBid) / bestAsk) * 100;
        // Skip if spread too wide
        if (spread > 5) {
            this.skipCount++;
            return;
        }
        const tradeSide = convergence.tradeSide;
        const isPaper = this.mode === 'paper';
        // Position sizing
        const balance = isPaper ? this.paperBalance : 100; // TODO: use real balance
        const positionSize = balance * (this.config.perTradeRiskPercent / 100);
        const shares = Math.floor(positionSize / bestAsk);
        const cost = shares * bestAsk;
        if (shares < 1 || cost < 0.5) {
            this.skipCount++;
            return;
        }
        const tradeId = `scalp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        const now = Date.now();
        logger_1.logger.info('🔥 SCALP SIGNAL', {
            side: tradeSide,
            convergence: convergence.confidence.toFixed(0) + '%',
            lag: polymarketLag.toFixed(3) + '%',
            price: bestAsk,
            size: shares,
            cost: cost.toFixed(2),
            btcPrice: btcPrice.toFixed(2),
            paper: isPaper,
        });
        if (isPaper) {
            // Paper trade: simulate execution
            const trade = {
                id: tradeId,
                timestamp: now,
                marketQuestion: market.question,
                conditionId: market.conditionId,
                tokenId,
                side: 'BUY',
                outcome: tradeSide === 'UP' ? 'YES' : 'YES',
                tradeType: tradeSide,
                price: bestAsk,
                size: shares,
                cost,
                pnl: 0,
                pnlPercent: 0,
                btcPrice,
                polymarketLag,
                convergence: convergence.confidence,
                reason: convergence.details,
                status: 'open',
                isPaper: true,
            };
            this.store.addTrade(trade);
            const position = {
                id: tradeId,
                conditionId: market.conditionId,
                tokenId,
                marketQuestion: market.question,
                tradeType: tradeSide,
                outcome: tradeSide === 'UP' ? 'YES' : 'YES',
                entryPrice: bestAsk,
                currentPrice: bestAsk,
                size: shares,
                cost,
                pnl: 0,
                pnlPercent: 0,
                entryTime: now,
                btcEntryPrice: btcPrice,
                polymarketLag,
                convergence: convergence.confidence,
                status: 'open',
                isPaper: true,
            };
            this.store.openPosition(position);
            this.paperBalance -= cost;
            this.lastTradeTime = now;
            this.tradeCountToday++;
            // Auto-close after timeout or on next scan if TP/SL hit
            this.schedulePositionMonitor(position);
        }
        else {
            // Live trade: execute on Polymarket
            try {
                const result = await this.client.placeOrder({
                    tokenId,
                    side: 'BUY',
                    price: bestAsk,
                    size: shares,
                });
                if (result.success) {
                    const trade = {
                        id: tradeId,
                        timestamp: now,
                        marketQuestion: market.question,
                        conditionId: market.conditionId,
                        tokenId,
                        side: 'BUY',
                        outcome: tradeSide === 'UP' ? 'YES' : 'YES',
                        tradeType: tradeSide,
                        price: bestAsk,
                        size: shares,
                        cost,
                        pnl: 0,
                        pnlPercent: 0,
                        btcPrice,
                        polymarketLag,
                        convergence: convergence.confidence,
                        reason: convergence.details,
                        status: 'open',
                        orderId: result.orderId || '',
                        isPaper: false,
                    };
                    this.store.addTrade(trade);
                    const position = {
                        id: tradeId,
                        conditionId: market.conditionId,
                        tokenId,
                        marketQuestion: market.question,
                        tradeType: tradeSide,
                        outcome: tradeSide === 'UP' ? 'YES' : 'YES',
                        entryPrice: bestAsk,
                        currentPrice: bestAsk,
                        size: shares,
                        cost,
                        pnl: 0,
                        pnlPercent: 0,
                        entryTime: now,
                        btcEntryPrice: btcPrice,
                        polymarketLag,
                        convergence: convergence.confidence,
                        status: 'open',
                        isPaper: false,
                    };
                    this.store.openPosition(position);
                    this.lastTradeTime = now;
                    this.tradeCountToday++;
                    this.schedulePositionMonitor(position);
                }
                else {
                    logger_1.logger.error('Live trade failed', { error: result.error });
                }
            }
            catch (e) {
                logger_1.logger.error('Trade execution error', { error: e.message });
            }
        }
    }
    // ---- Position Monitor ----
    schedulePositionMonitor(position) {
        const monitor = async () => {
            if (!this.running)
                return;
            if (this.store.getOpenPositions().find(p => p.id === position.id) === undefined)
                return;
            try {
                const orderBook = await this.client.getOrderBook(position.tokenId);
                const currentPrice = orderBook.bids.length > 0 ? orderBook.bids[0].price : position.currentPrice;
                this.store.updatePositionPrice(position.id, currentPrice);
                const pos = this.store.getOpenPositions().find(p => p.id === position.id);
                if (!pos)
                    return;
                const pnlPercent = pos.pnlPercent;
                const elapsed = Date.now() - pos.entryTime;
                // Take profit
                if (pnlPercent >= this.config.takeProfitScalp) {
                    logger_1.logger.info('🎯 SCALP TP HIT', { id: pos.id, pnl: pnlPercent.toFixed(2) + '%' });
                    this.closePosition(pos, currentPrice, 'TAKE_PROFIT');
                    return;
                }
                // Stop loss
                if (pnlPercent <= -this.config.stopLossScalp) {
                    logger_1.logger.warn('🛑 SCALP SL HIT', { id: pos.id, pnl: pnlPercent.toFixed(2) + '%' });
                    this.closePosition(pos, currentPrice, 'STOP_LOSS');
                    return;
                }
                // Timeout: close after positionTimeoutMs
                if (elapsed >= this.config.positionTimeoutMs) {
                    logger_1.logger.info('⏰ Position timeout', { id: pos.id, elapsed: (elapsed / 1000).toFixed(0) + 's' });
                    this.closePosition(pos, currentPrice, 'TIMEOUT');
                    return;
                }
                // Continue monitoring
                setTimeout(monitor, 5000);
            }
            catch (e) {
                // Retry on error
                setTimeout(monitor, 10000);
            }
        };
        // Start monitoring after 5 seconds
        setTimeout(monitor, 5000);
    }
    async closePosition(pos, closePrice, reason) {
        const pnl = (closePrice - pos.entryPrice) * pos.size;
        const pnlPercent = pos.entryPrice > 0
            ? ((closePrice - pos.entryPrice) / pos.entryPrice) * 100
            : 0;
        this.store.closePosition(pos.id, closePrice, pnl, pnlPercent);
        if (pos.isPaper) {
            this.paperBalance += pos.cost + pnl;
        }
        // Record closing trade
        const closeTrade = {
            id: `close-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            timestamp: Date.now(),
            marketQuestion: pos.marketQuestion,
            conditionId: pos.conditionId,
            tokenId: pos.tokenId,
            side: 'SELL',
            outcome: pos.outcome,
            tradeType: pos.tradeType,
            price: closePrice,
            size: pos.size,
            cost: pos.cost,
            pnl,
            pnlPercent,
            btcPrice: this.btcPrice,
            polymarketLag: 0,
            convergence: 0,
            reason,
            status: 'closed',
            closeTimestamp: Date.now(),
            closePrice,
            isPaper: pos.isPaper,
        };
        this.store.addTrade(closeTrade);
        logger_1.logger.info('Position closed', {
            id: pos.id,
            type: pos.tradeType,
            reason,
            pnl: pnl.toFixed(4),
            pnlPercent: pnlPercent.toFixed(2) + '%',
        });
    }
    // ---- BTC Price Fallback ----
    async fetchBtcPriceRest() {
        try {
            const axios = require('axios');
            const resp = await axios.get(`${this.config.binanceRestUrl}/api/v3/ticker/price?symbol=BTCUSDT`, {
                timeout: 5000,
            });
            this.btcPrice = parseFloat(resp.data.price);
            this.btcChange5m = 0;
            logger_1.logger.info('Fetched BTC price via REST', { price: this.btcPrice });
        }
        catch (e) {
            logger_1.logger.error('Failed to fetch BTC price', { error: e.message });
        }
    }
    // ---- State ----
    getState() {
        const openPositions = this.store.getOpenPositions();
        return {
            running: this.running,
            mode: this.mode,
            btcPrice: this.btcPrice || this.binance.getPrice(),
            btcPrice5mAgo: this.binance.getPrice5mAgo(),
            btcPriceChange5m: this.btcChange5m || this.binance.getChange5m(),
            activeConvergence: this.lastConvergence,
            positions: openPositions,
            trades: this.store.getTrades(50),
            totalPnl: this.store.getTotalPnl(),
            dailyPnl: this.store.getDailyPnl(),
            winRate: this.store.getWinRate(),
            totalTrades: this.store.getTotalTrades(),
            winningTrades: this.store.getWinningTrades(),
            losingTrades: this.store.getLosingTrades(),
            signals: this.lastSignals,
            lastSignalTime: this.lastSignalTime,
            scanCount: this.scanCount,
            tradeCount: this.store.getTotalTrades(),
            skipCount: this.skipCount,
            startTime: this.startTime,
            dailyCapUsed: this.dailyPnl,
            dailyCapLimit: this.config.dailyCapPercent,
            hardStopTriggered: this.hardStopTriggered,
            klines5m: this.binance.getKlines5m(),
            btcVolume5m: this.binance.getVolume5m(),
            binanceConnected: this.binance.isConnected(),
            polymarketConnected: true,
            lastError: null,
            lastSimulation: this.lastSimulation,
            simulationCount: this.simulationCount,
            calibrationAccuracy: this.miroFish.getCalibrationStats().accuracy * 100,
        };
    }
    isRunning() { return this.running; }
    getMode() { return this.mode; }
    getPaperBalance() { return this.paperBalance; }
}
exports.ScalperEngine = ScalperEngine;
