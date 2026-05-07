// ============================================================================
// Polymarket V13 Strategy Engine - Types
// ============================================================================

// ---- Original V11 Types ----

export interface Market {
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: string[];
  active: boolean;
  closed: boolean;
  endDate: string;
  liquidity: number;
  volume: number;
  clobTokenIds: string[];
  negRisk: boolean;
  groupSlug?: string;
}

export interface OrderBook {
  tokenId: string;
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  hash: string;
  timestamp: number;
}

export interface OrderBookEntry {
  price: number;
  size: number;
}

export interface TradeSignal {
  market: Market;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price: number;
  size: number;
  ev: number;
  confidence: number;
  reason: string;
  timestamp: number;
}

export interface Position {
  conditionId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  entryPrice: number;
  currentPrice: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  entryTime: number;
  market: Market;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  transactionHash?: string;
}

export interface WalletBalance {
  pol: number;
  usdc: number;
  usdcNative: number;
  totalUsd: number;
}

export interface RateLimitState {
  hourlyTrades: number;
  hourlyResetTime: number;
  dailyPnl: number;
  dailyResetTime: number;
}

export interface ManipulationCheck {
  isManipulation: boolean;
  volatilityPercent: number;
  priceChangePercent: number;
  pausedUntil: number | null;
  reason: string;
}

export interface StrategyMetrics {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  avgEv: number;
  maxDrawdown: number;
  sharpeRatio: number;
  kellyMultiplier: number;
}

export interface ScanResult {
  market: Market;
  orderBook: OrderBook;
  ev: number;
  spread: number;
  liquidity: number;
  pass: boolean;
  rejectReason?: string;
}

export interface EngineState {
  running: boolean;
  mode: 'scan' | 'trade' | 'monitor';
  positions: Map<string, Position>;
  rateLimit: RateLimitState;
  manipulationPauses: Map<string, number>;
  lastScanTime: number;
  totalPnl: number;
  dailyPnl: number;
  tradeHistory: TradeRecord[];
}

export interface TradeRecord {
  id: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  price: number;
  size: number;
  ev: number;
  pnl: number;
  timestamp: number;
  orderId: string;
  reason: string;
}

export interface EVCalculation {
  impliedProb: number;
  trueProb: number;
  ev: number;
  evPercent: number;
  kellySize: number;
  adjustedKellySize: number;
  details: string;
}

// ---- V13 Scalper Types ----

export interface BtcTick {
  price: number;
  quantity: number;
  timestamp: number;
  direction: 'up' | 'down';
}

export interface Kline5m {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  isFinal: boolean;
}

export interface SignalNode {
  name: string;
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  strength: number;
  weight: number;
  details: string;
}

export interface ConvergenceResult {
  direction: 'BULL' | 'BEAR' | 'NEUTRAL';
  strength: number;
  confidence: number;
  signals: SignalNode[];
  polymarketLag: number;
  shouldTrade: boolean;
  tradeSide: 'UP' | 'DOWN' | null;
  details: string;
}

export interface ScalperTrade {
  id: string;
  timestamp: number;
  marketQuestion: string;
  conditionId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  tradeType: 'UP' | 'DOWN';
  price: number;
  size: number;
  cost: number;
  pnl: number;
  pnlPercent: number;
  btcPrice: number;
  polymarketLag: number;
  convergence: number;
  reason: string;
  status: 'open' | 'closed';
  closeTimestamp?: number;
  closePrice?: number;
  orderId?: string;
  isPaper: boolean;
}

export interface ScalperPosition {
  id: string;
  conditionId: string;
  tokenId: string;
  marketQuestion: string;
  tradeType: 'UP' | 'DOWN';
  outcome: 'YES' | 'NO';
  entryPrice: number;
  currentPrice: number;
  size: number;
  cost: number;
  pnl: number;
  pnlPercent: number;
  entryTime: number;
  btcEntryPrice: number;
  polymarketLag: number;
  convergence: number;
  status: 'open' | 'closed';
  isPaper: boolean;
}

export interface ScalperState {
  running: boolean;
  mode: 'paper' | 'live' | 'idle';
  btcPrice: number;
  btcPrice5mAgo: number;
  btcPriceChange5m: number;
  activeConvergence: ConvergenceResult | null;
  positions: ScalperPosition[];
  trades: ScalperTrade[];
  totalPnl: number;
  dailyPnl: number;
  winRate: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  signals: SignalNode[];
  lastSignalTime: number;
  scanCount: number;
  tradeCount: number;
  skipCount: number;
  startTime: number;
  dailyCapUsed: number;
  dailyCapLimit: number;
  hardStopTriggered: boolean;
  klines5m: Kline5m[];
  btcVolume5m: number;
  binanceConnected: boolean;
  polymarketConnected: boolean;
  lastError: string | null;
  // MiroFish simulation
  lastSimulation: SimulationResult | null;
  simulationCount: number;
  calibrationAccuracy: number;
}

// ---- MiroFish Simulation Types ----

export interface SimulationAgent {
  type: string;
  bias: number;
  weight: number;
  description: string;
}

export interface SimulationState {
  btcPrice: number;
  btcChange5m: number;
  btcVolume5m: number;
  depthImbalance: number;
  trend: number;
  volatility: number;
  midPrice: number;
  spread: number;
  depthRatio: number;
  klinesClose: number[];
  summary: string;
}

export interface SimulationResult {
  direction: 'UP' | 'DOWN';
  upProbability: number;
  downProbability: number;
  confidence: number;
  expectedPnl: number;
  pnlStdDev: number;
  sharpe: number;
  kellyFraction: number;
  pnlDistribution: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
  simulationCount: number;
  elapsedMs: number;
  pricePaths: number[][];
  shouldTrade: boolean;
  marketContext: string;
}
