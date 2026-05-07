"use strict";
// ============================================================================
// Polymarket V11 Strategy Engine - Main Entry Point
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const BANNER = `
╔══════════════════════════════════════════════════════════╗
║           Polymarket V11 Strategy Engine                 ║
║                                                          ║
║  EV>5% | Yes<0.2 Skip | TP40% SL15% | Half-Kelly 10%  ║
║  Liquidity>$10k | Spread<5% | Anti-Manipulation 20%    ║
║  2 trades/hour | $2 daily loss limit                     ║
╚══════════════════════════════════════════════════════════╝
`;
const PORT = parseInt(process.env.PORT || '3000', 10);
// V11 Strategy Parameters
const STRATEGY_CONFIG = {
    minEvPercent: parseFloat(process.env.MIN_EV_PERCENT || '5'),
    maxYesPrice: parseFloat(process.env.MAX_YES_PRICE || '0.20'),
    takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '40'),
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '15'),
    kellyFraction: parseFloat(process.env.KELLY_FRACTION || '0.5'),
    maxPositionPercent: parseFloat(process.env.MAX_POSITION_PERCENT || '10'),
    minLiquidityUsd: parseFloat(process.env.MIN_LIQUIDITY_USD || '10000'),
    maxSpreadPercent: parseFloat(process.env.MAX_SPREAD_PERCENT || '5'),
    manipulationVolatilityThreshold: parseFloat(process.env.MANIPULATION_VOLATILITY_THRESHOLD || '20'),
    manipulationPauseMinutes: parseFloat(process.env.MANIPULATION_PAUSE_MINUTES || '60'),
    maxTradesPerHour: parseFloat(process.env.MAX_TRADES_PER_HOUR || '2'),
    maxDailyLossUsd: parseFloat(process.env.MAX_DAILY_LOSS_USD || '2'),
    tradingWallet: process.env.TRADING_WALLET || '0x13642cdE3d64d9d79b4837920667D881f285e937',
    profitRecoveryWallet: process.env.PROFIT_RECOVERY_WALLET || '0xFe332cA54738CBa561518A3a458BA6eFFfc3636D',
    hubPublicWallet: process.env.HUB_PUBLIC_WALLET || '0x2F88715F35712C8627b7AF2Ead04baA4a449542c',
};
// Engine state
let engineRunning = false;
let engineMode = 'idle';
let positions = [];
let trades = [];
let totalPnl = 0;
let dailyPnl = 0;
let lastScanTime = 0;
// Lazy-loaded engine (heavy deps loaded on demand)
let StrategyEngine = null;
async function loadEngine() {
    if (StrategyEngine)
        return StrategyEngine;
    try {
        const { StrategyEngine: Engine } = await Promise.resolve().then(() => __importStar(require('./core/engine')));
        const { config } = await Promise.resolve().then(() => __importStar(require('./core/config')));
        StrategyEngine = new Engine(config);
        return StrategyEngine;
    }
    catch (error) {
        console.error('Failed to load engine:', error.message);
        return null;
    }
}
async function main() {
    console.log(BANNER);
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // Health check
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            version: '11.0.0',
            engine: engineRunning ? 'running' : 'idle',
            mode: engineMode,
            timestamp: Date.now(),
        });
    });
    // Engine state
    app.get('/api/state', (_req, res) => {
        res.json({
            running: engineRunning,
            mode: engineMode,
            totalPnl: totalPnl.toFixed(4),
            dailyPnl: dailyPnl.toFixed(4),
            positionsCount: positions.length,
            tradeCount: trades.length,
            lastScanTime: lastScanTime ? new Date(lastScanTime).toISOString() : null,
        });
    });
    // Get positions
    app.get('/api/positions', (_req, res) => {
        res.json(positions);
    });
    // Get trade history
    app.get('/api/trades', (_req, res) => {
        res.json(trades);
    });
    // Start engine
    app.post('/api/start', async (req, res) => {
        const mode = req.body.mode || 'scan';
        try {
            const engine = await loadEngine();
            if (engine) {
                await engine.start(mode);
                engineRunning = true;
                engineMode = mode;
                res.json({ success: true, mode });
            }
            else {
                // Fallback: start in lightweight mode
                engineRunning = true;
                engineMode = mode;
                res.json({ success: true, mode, note: 'Running in lightweight mode (no trading)' });
            }
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    // Stop engine
    app.post('/api/stop', (_req, res) => {
        engineRunning = false;
        engineMode = 'idle';
        res.json({ success: true });
    });
    // Scan markets (lightweight)
    app.post('/api/scan', async (_req, res) => {
        try {
            const engine = await loadEngine();
            if (engine) {
                const results = await engine.scanMarkets();
                lastScanTime = Date.now();
                res.json({
                    total: results.length,
                    passed: results.filter((r) => r.pass).length,
                    results: results.slice(0, 20),
                });
            }
            else {
                lastScanTime = Date.now();
                res.json({
                    total: 0,
                    passed: 0,
                    message: 'Engine not available. Configure API keys to enable scanning.',
                    config: STRATEGY_CONFIG,
                });
            }
        }
        catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
    // Config info
    app.get('/api/config', (_req, res) => {
        res.json({
            strategy: 'V11',
            parameters: STRATEGY_CONFIG,
        });
    });
    // Wallet info
    app.get('/api/wallet', async (_req, res) => {
        try {
            const { ethers } = await Promise.resolve().then(() => __importStar(require('ethers')));
            const rpc = process.env.POLYGON_RPC_URL || 'https://1rpc.io/matic';
            const provider = new ethers.JsonRpcProvider(rpc);
            const wallet = STRATEGY_CONFIG.tradingWallet;
            const polBalance = await provider.getBalance(wallet);
            const pol = parseFloat(ethers.formatEther(polBalance));
            res.json({
                wallet,
                network: 'polygon',
                pol: pol.toFixed(6),
                note: 'USDC balance requires contract call',
            });
        }
        catch (error) {
            res.json({
                wallet: STRATEGY_CONFIG.tradingWallet,
                network: 'polygon',
                error: error.message,
            });
        }
    });
    // Start server
    app.listen(PORT, () => {
        console.log(`[V11 Engine] API server running on port ${PORT}`);
        console.log(`[V11 Engine] Health: http://localhost:${PORT}/health`);
        console.log(`[V11 Engine] API: http://localhost:${PORT}/api/`);
    });
    // Graceful shutdown
    const shutdown = () => {
        console.log('[V11 Engine] Shutting down...');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
