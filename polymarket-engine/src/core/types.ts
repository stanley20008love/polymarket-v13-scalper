// ============================================================================
// Polymarket V11 Strategy Engine - Types
// ============================================================================

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
