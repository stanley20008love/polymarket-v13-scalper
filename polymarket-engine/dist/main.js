"use strict";
// ============================================================================
// Polymarket V16 - 五引擎50U模拟盘
// ============================================================================
// 5策略独立运行，各50U模拟盘:
// 1. BTC 5分钟剥头皮 (ScalperEngine)
// 2. Marketing101 5源信号 (Marketing101Engine)
// 3. 跟单交易 (CopyTradingEngine)
// 4. 债券策略 (BondEngine)
// 5. Kelly均值回归 (KellyEngine)
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const path = __importStar(require("path"));
const config_1 = require("./core/config");
const scalper_1 = require("./core/scalper");
const marketing101_engine_1 = require("./core/marketing101-engine");
const copy_trading_engine_1 = require("./core/copy-trading-engine");
const bond_engine_1 = require("./core/bond-engine");
const kelly_engine_1 = require("./core/kelly-engine");
const binance_ws_1 = require("./feeds/binance-ws");
const polymarket_client_1 = require("./services/polymarket-client");
const trade_store_1 = require("./storage/trade-store");
const logger_1 = require("./utils/logger");
dotenv_1.default.config();
const VERSION = '16.0.0';
const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║         Polymarket V16 - 五引擎50U模拟盘                         ║
║                                                                   ║
║  策略1: ⚡ BTC 5分钟剥头皮 (CLOB价格滞后套利)                    ║
║  策略2: 🧠 Marketing101 (5源信号: Claude+MiroFish+BTC+OTC+订单簿)║
║  策略3: 📋 跟单交易 (>90%胜率钱包自动跟单)                       ║
║  策略4: 🏦 债券策略 (>90%概率市场稳健收益)                       ║
║  策略5: 🎯 Kelly均值回归 (EMA12+1/4Kelly+5源融合)                ║
║                                                                   ║
║  各策略独立50U模拟盘 | 日PnL自动重置 | 余额保护                   ║
╚══════════════════════════════════════════════════════════════════╝
`;
const config = (0, config_1.loadConfig)();
const PORT = config.port;
// 核心组件
let scalper = null;
let marketing101 = null;
let copyTrading = null;
let bondEngine = null;
let kellyEngine = null;
let binance = null;
let client = null;
let store = null;
async function main() {
    console.log(BANNER);
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use(express_1.default.static(path.join(__dirname, '..', 'public')));
    // ---- Health Check ----
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            version: VERSION,
            engines: {
                scalper: scalper?.isRunning() ? 'running' : 'idle',
                marketing101: marketing101?.isRunning() ? 'running' : 'idle',
                copyTrading: copyTrading?.isRunning() ? 'running' : 'idle',
                bond: bondEngine?.isRunning() ? 'running' : 'idle',
                kelly: kellyEngine?.isRunning() ? 'running' : 'idle',
            },
            binance: binance?.isConnected() || false,
            timestamp: Date.now(),
        });
    });
    // ---- Engine State (for Dashboard) ----
    app.get('/api/state', (_req, res) => {
        try {
            res.json({
                version: VERSION,
                running: scalper?.isRunning() || marketing101?.isRunning() || copyTrading?.isRunning() || bondEngine?.isRunning() || kellyEngine?.isRunning() || false,
                scalper: scalper?.getState() || null,
                marketing101: marketing101?.getState() || null,
                copyTrading: copyTrading?.getState() || null,
                bond: bondEngine?.getState() || null,
                kelly: kellyEngine?.getState() || null,
                binance: {
                    connected: binance?.isConnected() || false,
                    btcPrice: binance?.getPrice() || 0,
                    btcChange5m: binance?.getChange5m() || 0,
                    btcVolume5m: binance?.getVolume5m() || 0,
                },
            });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // ---- Per-Engine API Endpoints ----
    // Scalper
    app.get('/api/scalper', (_req, res) => {
        res.json(scalper?.getState() || { running: false });
    });
    // Marketing101
    app.get('/api/m101', (_req, res) => {
        res.json(marketing101?.getState() || { running: false });
    });
    app.get('/api/m101/signals', (_req, res) => {
        const state = marketing101?.getState();
        res.json({
            signals: state?.lastSignals || [],
            decision: state?.lastDecision || null,
            otcSnapshot: state?.lastOtcSnapshot || null,
            closedBook: state?.lastClosedBook || null,
            btcSim: state?.lastBtcSim || null,
        });
    });
    app.get('/api/m101/trades', (_req, res) => {
        res.json({
            open: marketing101?.getOpenPositions() || [],
            closed: marketing101?.getClosedTrades() || [],
        });
    });
    // Copy Trading
    app.get('/api/copy', (_req, res) => {
        res.json(copyTrading?.getState() || { running: false });
    });
    app.get('/api/copy/trades', (_req, res) => {
        res.json({
            open: copyTrading?.getOpenPositions() || [],
            closed: copyTrading?.getClosedTrades() || [],
        });
    });
    // Bond
    app.get('/api/bond', (_req, res) => {
        res.json(bondEngine?.getState() || { running: false });
    });
    app.get('/api/bond/trades', (_req, res) => {
        res.json({
            open: bondEngine?.getOpenPositions() || [],
            closed: bondEngine?.getClosedTrades() || [],
        });
    });
    // Kelly
    app.get('/api/kelly', (_req, res) => {
        res.json(kellyEngine?.getState() || { running: false });
    });
    app.get('/api/kelly/trades', (_req, res) => {
        res.json({
            open: kellyEngine?.getOpenPositions() || [],
            closed: kellyEngine?.getClosedTrades() || [],
        });
    });
    // ---- Shared API ----
    app.get('/api/trades', (_req, res) => {
        res.json(store?.getTrades() || []);
    });
    app.get('/api/positions', (_req, res) => {
        res.json(store?.getOpenPositions() || []);
    });
    app.get('/api/export', (_req, res) => {
        try {
            const data = store?.exportAll() || { trades: [], positions: [], stats: {} };
            res.setHeader('Content-Disposition', `attachment; filename=polymarket-v${VERSION}-export.json`);
            res.json({
                ...data,
                marketing101: marketing101?.getState() || null,
                copyTrading: copyTrading?.getState() || null,
                bond: bondEngine?.getState() || null,
                kelly: kellyEngine?.getState() || null,
            });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.get('/api/config', (_req, res) => {
        res.json({
            版本: `V${VERSION}`,
            模式: '模拟盘 (5策略独立50U)',
            策略: {
                剥头皮: { 启用: true, 滞后阈值: config.lagThreshold + '%', 止盈: config.takeProfitScalp + '%', 止损: config.stopLossScalp + '%' },
                Marketing101: { 启用: true, 信号源: ['Claude', 'MiroFish', 'BTC模拟', 'OTC', '订单簿'], 共识: '3/5 (60%)' },
                跟单: { 启用: true, 最低胜率: '90%', 最低盈利: '$100K' },
                债券: { 启用: true, 最低概率: '90%', 最低年化: '15%' },
                Kelly: { 启用: true, Kelly比例: '1/4', EMA周期: 12, 偏离阈值: '5%' },
            },
        });
    });
    // ---- Start/Stop ----
    app.post('/api/start', async (req, res) => {
        try {
            if (scalper?.isRunning()) {
                return res.json({ success: false, error: '引擎已在运行' });
            }
            // Initialize shared components
            if (!binance)
                binance = new binance_ws_1.BinanceFeed(config);
            if (!client)
                client = new polymarket_client_1.PolymarketClient(config);
            if (!store)
                store = new trade_store_1.TradeStore();
            // 1. Scalper Engine
            scalper = new scalper_1.ScalperEngine(config, binance, client, store);
            await scalper.start();
            // 2. Marketing101 Engine
            if (!marketing101)
                marketing101 = new marketing101_engine_1.Marketing101Engine(config);
            const btcPrice = binance.getPrice() || 80000;
            await marketing101.start(btcPrice);
            // 3. Copy Trading Engine
            if (!copyTrading)
                copyTrading = new copy_trading_engine_1.CopyTradingEngine(config);
            await copyTrading.start();
            // 4. Bond Engine
            if (!bondEngine)
                bondEngine = new bond_engine_1.BondEngine(config);
            await bondEngine.start();
            // 5. Kelly Engine
            if (!kellyEngine)
                kellyEngine = new kelly_engine_1.KellyEngine(config);
            await kellyEngine.start(btcPrice);
            res.json({
                success: true,
                engines: {
                    scalper: scalper.getMode(),
                    marketing101: marketing101.isRunning() ? '运行中' : '空闲',
                    copyTrading: copyTrading.isRunning() ? '运行中' : '空闲',
                    bond: bondEngine.isRunning() ? '运行中' : '空闲',
                    kelly: kellyEngine.isRunning() ? '运行中' : '空闲',
                },
            });
        }
        catch (e) {
            logger_1.logger.error('启动引擎失败', { error: e.message });
            res.status(500).json({ success: false, error: e.message });
        }
    });
    app.post('/api/stop', (_req, res) => {
        try {
            if (scalper) {
                scalper.stop();
                scalper = null;
            }
            if (marketing101) {
                marketing101.stop();
            }
            if (copyTrading) {
                copyTrading.stop();
            }
            if (bondEngine) {
                bondEngine.stop();
            }
            if (kellyEngine) {
                kellyEngine.stop();
            }
            res.json({ success: true, 消息: '五引擎已停止' });
        }
        catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
    // Dashboard route
    app.get('/', (_req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
    });
    // ---- Start Server ----
    app.listen(PORT, () => {
        console.log(`[V${VERSION}] API服务器运行于端口 ${PORT}`);
        console.log(`[V${VERSION}] 面板: http://localhost:${PORT}/`);
    });
    // Auto-start
    if (config.scalperEnabled) {
        setTimeout(async () => {
            try {
                console.log('[V16] 自动启动五引擎...');
                binance = new binance_ws_1.BinanceFeed(config);
                client = new polymarket_client_1.PolymarketClient(config);
                store = new trade_store_1.TradeStore();
                // 1. Scalper
                scalper = new scalper_1.ScalperEngine(config, binance, client, store);
                await scalper.start();
                const btcPrice = binance.getPrice() || 80000;
                // 2. Marketing101
                marketing101 = new marketing101_engine_1.Marketing101Engine(config);
                await marketing101.start(btcPrice);
                // 3. Copy Trading
                copyTrading = new copy_trading_engine_1.CopyTradingEngine(config);
                await copyTrading.start();
                // 4. Bond
                bondEngine = new bond_engine_1.BondEngine(config);
                await bondEngine.start();
                // 5. Kelly
                kellyEngine = new kelly_engine_1.KellyEngine(config);
                await kellyEngine.start(btcPrice);
                console.log('[V16] 五引擎启动成功 (5×50U模拟盘)');
            }
            catch (e) {
                console.error('[V16] 自动启动失败:', e.message);
                console.log('[V16] 请使用 POST /api/start 手动启动');
            }
        }, 3000);
    }
    // Update BTC price for all engines
    setInterval(() => {
        if (!binance)
            return;
        const price = binance.getPrice();
        if (price <= 0)
            return;
        if (marketing101 && marketing101.isRunning()) {
            marketing101.updateBtcPrice(price, []);
        }
        if (kellyEngine && kellyEngine.isRunning()) {
            kellyEngine.updateBtcPrice(price);
        }
    }, 5000);
    // Graceful shutdown
    const shutdown = () => {
        console.log('[V16] 关机中...');
        if (scalper)
            scalper.stop();
        if (marketing101)
            marketing101.stop();
        if (copyTrading)
            copyTrading.stop();
        if (bondEngine)
            bondEngine.stop();
        if (kellyEngine)
            kellyEngine.stop();
        if (store)
            store.save();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((error) => {
    console.error('致命错误:', error);
    process.exit(1);
});
