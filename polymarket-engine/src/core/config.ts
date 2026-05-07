// ============================================================================
// Polymarket V13 Strategy Engine - Configuration
// ============================================================================

import dotenv from 'dotenv';
dotenv.config();

export interface StrategyConfig {
  // Wallet
  hubPublicWallet: string;
  tradingWallet: string;
  profitRecoveryWallet: string;
  privateKey: string;

  // API
  polymarketApiUrl: string;
  polymarketWsUrl: string;
  polymarketApiKey: string;
  polymarketApiSecret: string;
  polymarketApiPassphrase: string;
  polygonRpcUrl: string;

  // Binance
  binanceWsUrl: string;
  binanceRestUrl: string;

  // Strategy V11
  minEvPercent: number;
  maxYesPrice: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  kellyFraction: number;
  maxPositionPercent: number;
  minLiquidityUsd: number;
  maxSpreadPercent: number;
  manipulationVolatilityThreshold: number;
  manipulationPauseMinutes: number;
  maxTradesPerHour: number;
  maxDailyLossUsd: number;

  // V13 Scalper
  scalperEnabled: boolean;
  scalperMode: 'paper' | 'live';
  lagThreshold: number;           // 0.3% minimum lag to trade
  perTradeRiskPercent: number;    // 0.5% risk per trade
  dailyCapPercent: number;        // 2% daily cap
  hardStopPercent: number;        // -0.4% hard stop
  minConvergence: number;         // 70% signal convergence required
  maxActivePositions: number;     // max concurrent positions
  positionTimeoutMs: number;      // close position after timeout
  takeProfitScalp: number;        // 0.8% take profit for scalp
  stopLossScalp: number;          // 0.3% stop loss for scalp

  // Server
  port: number;
  logLevel: string;
  nodeEnv: string;
  dryRun: boolean;
}

export function loadConfig(): StrategyConfig {
  return {
    hubPublicWallet: process.env.HUB_PUBLIC_WALLET || '0x2F88715F35712C8627b7AF2Ead04baA4a449542c',
    tradingWallet: process.env.TRADING_WALLET || '0x13642cdE3d64d9d79b4837920667D881f285e937',
    profitRecoveryWallet: process.env.PROFIT_RECOVERY_WALLET || '0xFe332cA54738CBa561518A3a458BA6eFFfc3636D',
    privateKey: process.env.PRIVATE_KEY || '',

    polymarketApiUrl: process.env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
    polymarketWsUrl: process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws',
    polymarketApiKey: process.env.POLYMARKET_API_KEY || '',
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET || '',
    polymarketApiPassphrase: process.env.POLYMARKET_API_PASSPHRASE || '',
    polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://1rpc.io/matic',

    binanceWsUrl: process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443/ws',
    binanceRestUrl: process.env.BINANCE_REST_URL || 'https://api.binance.com',

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

    scalperEnabled: process.env.SCALPER_ENABLED !== 'false',
    scalperMode: (process.env.SCALPER_MODE as 'paper' | 'live') || 'paper',
    lagThreshold: parseFloat(process.env.LAG_THRESHOLD || '0.1'),
    perTradeRiskPercent: parseFloat(process.env.PER_TRADE_RISK_PERCENT || '2'),
    dailyCapPercent: parseFloat(process.env.DAILY_CAP_PERCENT || '2'),
    hardStopPercent: parseFloat(process.env.HARD_STOP_PERCENT || '-0.4'),
    minConvergence: parseFloat(process.env.MIN_CONVERGENCE || '35'),
    maxActivePositions: parseInt(process.env.MAX_ACTIVE_POSITIONS || '3', 10),
    positionTimeoutMs: parseInt(process.env.POSITION_TIMEOUT_MS || '300000', 10),
    takeProfitScalp: parseFloat(process.env.TAKE_PROFIT_SCALP || '0.8'),
    stopLossScalp: parseFloat(process.env.STOP_LOSS_SCALP || '0.3'),

    port: parseInt(process.env.PORT || '3000', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development',
    dryRun: process.env.DRY_RUN === 'true',
  };
}

export const config = loadConfig();
