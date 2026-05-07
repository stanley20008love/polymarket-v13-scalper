"use strict";
// ============================================================================
// Polymarket V13 Strategy Engine - Main Entry Point
// ============================================================================
// BTC 5MIN Scalper + V11 Strategy + Visual Dashboard
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
const binance_ws_1 = require("./feeds/binance-ws");
const polymarket_client_1 = require("./services/polymarket-client");
const trade_store_1 = require("./storage/trade-store");
const logger_1 = require("./utils/logger");
dotenv_1.default.config();
const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║           Polymarket V13 - BTC 5MIN Scalper Engine               ║
║                                                                   ║
║  Edge: CLOB Price Lag Exploitation                                ║
║  - Binance WS → BTC Realtime + 5M Klines                         ║
║  - Signal Convergence > 70% → Trade                               ║
║  - Lag > 0.3% → Execute < 5s                                      ║
║  - TP 0.8% | SL 0.3% | Daily Cap 2% | Hard Stop -0.4%           ║
║  - Paper Mode by default | Live when API keys set                 ║
╚══════════════════════════════════════════════════════════════════╝
`;
const config = (0, config_1.loadConfig)();
const PORT = config.port;
// Core components
let scalper = null;
let binance = null;
let client = null;
let store = null;
async function main() {
    console.log(BANNER);
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Serve dashboard static files
    app.use(express_1.default.static(path.join(__dirname, '..', 'public')));
    // ---- API Routes ----
    // Health check
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            version: '13.0.0',
            engine: scalper?.isRunning() ? 'running' : 'idle',
            mode: scalper?.getMode() || 'idle',
            binance: binance?.isConnected() || false,
            timestamp: Date.now(),
        });
    });
    // Full engine state (for dashboard)
    app.get('/api/state', (_req, res) => {
        try {
            if (!scalper) {
                return res.json({
                    running: false,
                    mode: 'idle',
                    btcPrice: 0,
                    btcPrice5mAgo: 0,
                    btcPriceChange5m: 0,
                    activeConvergence: null,
                    positions: [],
                    trades: [],
                    totalPnl: 0,
                    dailyPnl: 0,
                    winRate: 0,
                    totalTrades: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    signals: [],
                    lastSignalTime: 0,
                    scanCount: 0,
                    tradeCount: 0,
                    skipCount: 0,
                    startTime: 0,
                    dailyCapUsed: 0,
                    dailyCapLimit: config.dailyCapPercent,
                    hardStopTriggered: false,
                    klines5m: [],
                    btcVolume5m: 0,
                    binanceConnected: false,
                    polymarketConnected: false,
                    lastError: null,
                });
            }
            res.json(scalper.getState());
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Get all trades
    app.get('/api/trades', (_req, res) => {
        try {
            const trades = store?.getTrades() || [];
            res.json(trades);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Get open positions
    app.get('/api/positions', (_req, res) => {
        try {
            const positions = store?.getOpenPositions() || [];
            res.json(positions);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Get closed positions
    app.get('/api/positions/closed', (_req, res) => {
        try {
            const trades = store?.getTrades() || [];
            const closedTrades = trades.filter(t => t.status === 'closed' && t.side === 'SELL');
            res.json(closedTrades);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Get signals
    app.get('/api/signals', (_req, res) => {
        try {
            const state = scalper?.getState();
            res.json({
                signals: state?.signals || [],
                convergence: state?.activeConvergence || null,
                lastSignalTime: state?.lastSignalTime || 0,
            });
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Get config
    app.get('/api/config', (_req, res) => {
        res.json({
            version: 'V13',
            scalper: {
                enabled: config.scalperEnabled,
                mode: config.scalperMode,
                lagThreshold: config.lagThreshold + '%',
                perTradeRisk: config.perTradeRiskPercent + '%',
                dailyCap: config.dailyCapPercent + '%',
                hardStop: config.hardStopPercent + '%',
                minConvergence: config.minConvergence + '%',
                maxActivePositions: config.maxActivePositions,
                takeProfitScalp: config.takeProfitScalp + '%',
                stopLossScalp: config.stopLossScalp + '%',
            },
            wallets: {
                trading: config.tradingWallet,
                profitRecovery: config.profitRecoveryWallet,
            },
            binance: {
                ws: config.binanceWsUrl ? 'configured' : 'default',
                rest: config.binanceRestUrl ? 'configured' : 'default',
            },
            polymarket: {
                apiUrl: config.polymarketApiUrl,
                apiKeySet: !!config.polymarketApiKey,
            },
        });
    });
    // Start scalper
    app.post('/api/start', async (req, res) => {
        try {
            const mode = req.body.mode || config.scalperMode;
            if (scalper?.isRunning()) {
                return res.json({ success: false, error: 'Engine already running' });
            }
            // Initialize components if needed
            if (!binance)
                binance = new binance_ws_1.BinanceFeed(config);
            if (!client)
                client = new polymarket_client_1.PolymarketClient(config);
            if (!store)
                store = new trade_store_1.TradeStore();
            scalper = new scalper_1.ScalperEngine(config, binance, client, store);
            // Override mode if specified
            if (mode === 'live' && !config.polymarketApiKey) {
                logger_1.logger.warn('No API key set, falling back to paper mode');
            }
            await scalper.start();
            res.json({ success: true, mode: scalper.getMode() });
        }
        catch (e) {
            logger_1.logger.error('Failed to start scalper', { error: e.message });
            res.status(500).json({ success: false, error: e.message });
        }
    });
    // Stop scalper
    app.post('/api/stop', (_req, res) => {
        try {
            if (scalper) {
                scalper.stop();
                scalper = null;
            }
            res.json({ success: true });
        }
        catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });
    // Export all data
    app.get('/api/export', (_req, res) => {
        try {
            const data = store?.exportAll() || { trades: [], positions: [], stats: {} };
            res.setHeader('Content-Disposition', 'attachment; filename=polymarket-export.json');
            res.json(data);
        }
        catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    // Dashboard route
    app.get('/', (_req, res) => {
        res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
    });
    // ---- Start Server ----
    app.listen(PORT, () => {
        console.log(`[V13 Scalper] API server running on port ${PORT}`);
        console.log(`[V13 Scalper] Dashboard: http://localhost:${PORT}/`);
        console.log(`[V13 Scalper] API: http://localhost:${PORT}/api/`);
        console.log(`[V13 Scalper] Mode: ${config.scalperMode}${config.dryRun ? ' (DRY RUN)' : ''}`);
    });
    // Auto-start scalper if enabled
    if (config.scalperEnabled) {
        setTimeout(async () => {
            try {
                console.log('[V13 Scalper] Auto-starting scalper engine...');
                binance = new binance_ws_1.BinanceFeed(config);
                client = new polymarket_client_1.PolymarketClient(config);
                store = new trade_store_1.TradeStore();
                scalper = new scalper_1.ScalperEngine(config, binance, client, store);
                await scalper.start();
                console.log('[V13 Scalper] Engine started successfully');
            }
            catch (e) {
                console.error('[V13 Scalper] Auto-start failed:', e.message);
                console.log('[V13 Scalper] Use POST /api/start to start manually');
            }
        }, 3000);
    }
    // Graceful shutdown
    const shutdown = () => {
        console.log('[V13 Scalper] Shutting down...');
        if (scalper)
            scalper.stop();
        if (store)
            store.save();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
