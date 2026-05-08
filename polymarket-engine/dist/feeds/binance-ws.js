"use strict";
// ============================================================================
// Polymarket V13 - Binance WebSocket Feed
// ============================================================================
// Real-time BTC price + 5M klines from Binance
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinanceFeed = void 0;
const ws_1 = __importDefault(require("ws"));
const logger_1 = require("../utils/logger");
class BinanceFeed {
    config;
    ws = null;
    reconnectTimer = null;
    connected = false;
    // BTC data
    currentPrice = 0;
    price5mAgo = 0;
    lastTickTime = 0;
    recentTicks = [];
    klines5m = [];
    currentKline = null;
    depthBids = new Map();
    depthAsks = new Map();
    // Callbacks
    onPriceUpdate = null;
    onKlineUpdate = null;
    reconnectAttempts = 0;
    maxReconnectAttempts = 20; // Max 20 reconnection attempts
    constructor(config) {
        this.config = config;
    }
    setCallbacks(onPrice, onKline) {
        this.onPriceUpdate = onPrice;
        this.onKlineUpdate = onKline;
    }
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                const streams = [
                    'btcusdt@trade',
                    'btcusdt@kline_5m',
                    'btcusdt@depth20@100ms',
                ].join('/');
                const url = `${this.config.binanceWsUrl}/${streams}`;
                logger_1.logger.info('Connecting to Binance WebSocket', { url: url.replace(/wss?:\/\/[^/]+/, 'wss://***') });
                this.ws = new ws_1.default(url, {
                    handshakeTimeout: 10000,
                    maxPayload: 1024 * 1024,
                });
                this.ws.on('open', () => {
                    this.connected = true;
                    logger_1.logger.info('Binance WebSocket connected');
                    resolve();
                });
                this.ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        this.handleMessage(msg);
                    }
                    catch (e) {
                        // Ignore parse errors
                    }
                });
                this.ws.on('error', (error) => {
                    logger_1.logger.error('Binance WebSocket error', { error: error.message });
                    if (!this.connected) {
                        reject(error);
                    }
                });
                this.ws.on('close', () => {
                    this.connected = false;
                    logger_1.logger.warn('Binance WebSocket closed, reconnecting in 5s...');
                    this.scheduleReconnect();
                });
                this.ws.on('ping', () => {
                    this.ws?.pong();
                });
                // Timeout for initial connection
                setTimeout(() => {
                    if (!this.connected) {
                        reject(new Error('Binance WebSocket connection timeout'));
                    }
                }, 15000);
            }
            catch (error) {
                logger_1.logger.error('Failed to create Binance WebSocket', { error: error.message });
                reject(error);
            }
        });
    }
    handleMessage(msg) {
        try {
            if (msg.e === 'trade') {
                this.handleTrade(msg);
            }
            else if (msg.e === 'kline') {
                this.handleKline(msg);
            }
            else if (msg.lastUpdateId) {
                this.handleDepth(msg);
            }
        }
        catch (e) {
            // Silently ignore
        }
    }
    handleTrade(msg) {
        const price = parseFloat(msg.p);
        const quantity = parseFloat(msg.q);
        const timestamp = msg.T;
        const tick = {
            price,
            quantity,
            timestamp,
            direction: msg.m ? 'down' : 'up', // m=true means seller is maker → price went down
        };
        this.currentPrice = price;
        this.lastTickTime = timestamp;
        // Keep last 1000 ticks
        this.recentTicks.push(tick);
        if (this.recentTicks.length > 1000) {
            this.recentTicks.shift();
        }
        // Calculate 5m price change
        const fiveMinAgo = timestamp - 5 * 60 * 1000;
        const oldTicks = this.recentTicks.filter(t => t.timestamp <= fiveMinAgo);
        if (oldTicks.length > 0) {
            this.price5mAgo = oldTicks[oldTicks.length - 1].price;
        }
        else if (this.recentTicks.length > 0) {
            this.price5mAgo = this.recentTicks[0].price;
        }
        const change5m = this.price5mAgo > 0
            ? ((price - this.price5mAgo) / this.price5mAgo) * 100
            : 0;
        if (this.onPriceUpdate) {
            this.onPriceUpdate(price, change5m);
        }
    }
    handleKline(msg) {
        const k = msg.k;
        const kline = {
            openTime: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            closeTime: k.T,
            isFinal: k.x,
        };
        this.currentKline = kline;
        if (kline.isFinal) {
            this.klines5m.push(kline);
            if (this.klines5m.length > 100) {
                this.klines5m.shift();
            }
        }
        if (this.onKlineUpdate) {
            this.onKlineUpdate(kline);
        }
    }
    handleDepth(msg) {
        this.depthBids = new Map((msg.bids || []).slice(0, 20).map((b) => [parseFloat(b[0]), parseFloat(b[1])]));
        this.depthAsks = new Map((msg.asks || []).slice(0, 20).map((a) => [parseFloat(a[0]), parseFloat(a[1])]));
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            logger_1.logger.error('Binance最大重连次数已达到，停止重连', {
                attempts: this.reconnectAttempts,
                max: this.maxReconnectAttempts,
            });
            return;
        }
        // Exponential backoff: 5s, 10s, 20s, 40s... max 60s
        const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 60000);
        logger_1.logger.info(`Binance重连 ${this.reconnectAttempts}/${this.maxReconnectAttempts}，${(delay / 1000).toFixed(0)}秒后重试`);
        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
                this.reconnectAttempts = 0; // Reset on success
            }
            catch (e) {
                logger_1.logger.error('Binance reconnect failed', { error: e.message });
                this.scheduleReconnect();
            }
        }, delay);
    }
    // ---- Public Getters ----
    getPrice() { return this.currentPrice; }
    getPrice5mAgo() { return this.price5mAgo; }
    getChange5m() {
        if (this.price5mAgo <= 0)
            return 0;
        return ((this.currentPrice - this.price5mAgo) / this.price5mAgo) * 100;
    }
    getKlines5m() { return [...this.klines5m]; }
    getCurrentKline() { return this.currentKline; }
    getRecentTicks() { return [...this.recentTicks]; }
    getDepthImbalance() {
        const bidVolume = Array.from(this.depthBids.values()).reduce((s, v) => s + v, 0);
        const askVolume = Array.from(this.depthAsks.values()).reduce((s, v) => s + v, 0);
        const total = bidVolume + askVolume;
        if (total === 0)
            return 0;
        return (bidVolume - askVolume) / total; // +1 = all bids (bullish), -1 = all asks (bearish)
    }
    getVolume5m() {
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        return this.recentTicks
            .filter(t => t.timestamp >= fiveMinAgo)
            .reduce((sum, t) => sum + t.quantity * t.price, 0);
    }
    isConnected() { return this.connected; }
    disconnect() {
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
}
exports.BinanceFeed = BinanceFeed;
