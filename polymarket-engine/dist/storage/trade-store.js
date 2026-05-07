"use strict";
// ============================================================================
// Polymarket V13 - Trade Store (In-Memory + JSON Persistence)
// ============================================================================
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../utils/logger");
const DATA_DIR = path.join(process.env.DATA_DIR || '/tmp', 'polymarket-data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const POSITIONS_FILE = path.join(DATA_DIR, 'positions.json');
class TradeStore {
    trades = [];
    positions = new Map();
    saveTimer = null;
    constructor() {
        this.loadData();
        this.startAutoSave();
    }
    // ---- Trades ----
    addTrade(trade) {
        this.trades.push(trade);
        logger_1.logger.info('Trade recorded', {
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
    updateTrade(id, updates) {
        const idx = this.trades.findIndex(t => t.id === id);
        if (idx >= 0) {
            this.trades[idx] = { ...this.trades[idx], ...updates };
        }
    }
    getTrades(limit) {
        const sorted = [...this.trades].sort((a, b) => b.timestamp - a.timestamp);
        return limit ? sorted.slice(0, limit) : sorted;
    }
    getOpenTrades() {
        return this.trades.filter(t => t.status === 'open');
    }
    // ---- Positions ----
    openPosition(position) {
        this.positions.set(position.id, position);
        logger_1.logger.info('Position opened', {
            id: position.id,
            type: position.tradeType,
            entryPrice: position.entryPrice,
            size: position.size,
            cost: position.cost.toFixed(2),
            btcPrice: position.btcEntryPrice.toFixed(2),
        });
    }
    closePosition(id, closePrice, pnl, pnlPercent) {
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
            logger_1.logger.info('Position closed', {
                id,
                type: pos.tradeType,
                pnl: pnl.toFixed(4),
                pnlPercent: pnlPercent.toFixed(2) + '%',
            });
        }
    }
    updatePositionPrice(id, currentPrice) {
        const pos = this.positions.get(id);
        if (pos) {
            pos.currentPrice = currentPrice;
            if (pos.entryPrice > 0) {
                pos.pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
                pos.pnl = pos.pnlPercent / 100 * pos.cost;
            }
        }
    }
    getOpenPositions() {
        return Array.from(this.positions.values()).filter(p => p.status === 'open');
    }
    getAllPositions() {
        return Array.from(this.positions.values());
    }
    // ---- Stats ----
    getTotalPnl() {
        return this.trades
            .filter(t => t.status === 'closed')
            .reduce((sum, t) => sum + t.pnl, 0);
    }
    getDailyPnl() {
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const dayStart = startOfDay.getTime();
        return this.trades
            .filter(t => t.status === 'closed' && t.timestamp >= dayStart)
            .reduce((sum, t) => sum + t.pnl, 0);
    }
    getWinRate() {
        const closed = this.trades.filter(t => t.status === 'closed');
        if (closed.length === 0)
            return 0;
        const wins = closed.filter(t => t.pnl > 0).length;
        return (wins / closed.length) * 100;
    }
    getTotalTrades() {
        return this.trades.filter(t => t.status === 'closed').length;
    }
    getWinningTrades() {
        return this.trades.filter(t => t.status === 'closed' && t.pnl > 0).length;
    }
    getLosingTrades() {
        return this.trades.filter(t => t.status === 'closed' && t.pnl <= 0).length;
    }
    // ---- Persistence ----
    loadData() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            if (fs.existsSync(TRADES_FILE)) {
                const data = fs.readFileSync(TRADES_FILE, 'utf8');
                this.trades = JSON.parse(data);
                logger_1.logger.info('Loaded trades from disk', { count: this.trades.length });
            }
            if (fs.existsSync(POSITIONS_FILE)) {
                const data = fs.readFileSync(POSITIONS_FILE, 'utf8');
                const positions = JSON.parse(data);
                for (const pos of positions) {
                    if (pos.status === 'open') {
                        this.positions.set(pos.id, pos);
                    }
                }
                logger_1.logger.info('Loaded open positions from disk', { count: this.positions.size });
            }
        }
        catch (e) {
            logger_1.logger.warn('Failed to load trade data', { error: e.message });
        }
    }
    saveData() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.writeFileSync(TRADES_FILE, JSON.stringify(this.trades, null, 2));
            fs.writeFileSync(POSITIONS_FILE, JSON.stringify(Array.from(this.positions.values()), null, 2));
        }
        catch (e) {
            logger_1.logger.debug('Failed to save trade data', { error: e.message });
        }
    }
    startAutoSave() {
        this.saveTimer = setInterval(() => {
            this.saveData();
        }, 30000); // Save every 30 seconds
    }
    save() {
        this.saveData();
    }
    destroy() {
        if (this.saveTimer)
            clearInterval(this.saveTimer);
        this.saveData();
    }
    // ---- Export ----
    exportAll() {
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
exports.TradeStore = TradeStore;
