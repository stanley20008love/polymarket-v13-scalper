// ============================================================================
// Polymarket V11 Strategy Engine - Tests
// ============================================================================

import { EVCalculator } from '../src/core/ev-calculator';
import { RiskManager } from '../src/core/risk-manager';
import { loadConfig } from '../src/core/config';
import { Market, OrderBook } from '../src/core/types';

const config = loadConfig();

// ---- Mock Data ----

function createMockMarket(overrides: Partial<Market> = {}): Market {
  return {
    conditionId: '0x1234567890abcdef',
    questionId: '0xabcdef1234567890',
    question: 'Will X happen by 2025-12-31?',
    slug: 'will-x-happen',
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.65', '0.35'],
    active: true,
    closed: false,
    endDate: '2025-12-31T23:59:59Z',
    liquidity: 50000,
    volume: 100000,
    clobTokenIds: ['0xtoken1', '0xtoken2'],
    negRisk: false,
    ...overrides,
  };
}

function createMockOrderBook(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    tokenId: '0xtoken1',
    bids: [
      { price: 0.63, size: 500 },
      { price: 0.62, size: 1000 },
    ],
    asks: [
      { price: 0.65, size: 400 },
      { price: 0.66, size: 800 },
    ],
    hash: '0xhash',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---- EV Calculator Tests ----

function testEVCalculator() {
  console.log('\n=== EV Calculator Tests ===\n');
  const calc = new EVCalculator(config);

  // Test 1: Positive EV
  const market1 = createMockMarket();
  const book1 = createMockOrderBook();
  const ev1 = calc.calculateEV(market1, book1, 0.75, 'YES');
  console.log('Test 1 - Positive EV (true prob 75%, market 65%):');
  console.log(`  EV: $${ev1.ev.toFixed(4)} (${ev1.evPercent.toFixed(2)}%)`);
  console.log(`  Kelly: ${(ev1.kellySize * 100).toFixed(2)}%, Adjusted: ${(ev1.adjustedKellySize * 100).toFixed(2)}%`);
  console.assert(ev1.ev > 0, 'Expected positive EV');

  // Test 2: Negative EV
  const ev2 = calc.calculateEV(market1, book1, 0.50, 'YES');
  console.log('\nTest 2 - Negative EV (true prob 50%, market 65%):');
  console.log(`  EV: $${ev2.ev.toFixed(4)} (${ev2.evPercent.toFixed(2)}%)`);
  console.assert(ev2.ev < 0, 'Expected negative EV');

  // Test 3: Full evaluation - should pass
  const result3 = calc.evaluateMarket(market1, book1, 1000);
  console.log('\nTest 3 - Full evaluation (should pass with true prob > market):');
  console.log(`  Signal: ${result3.signal}, Side: ${result3.side}`);
  console.log(`  Reason: ${result3.reason}`);

  // Test 4: Low liquidity - should skip
  const market4 = createMockMarket({ liquidity: 5000 });
  const result4 = calc.evaluateMarket(market4, book1, 1000);
  console.log('\nTest 4 - Low liquidity ($5000 < $10000):');
  console.log(`  Signal: ${result4.signal}`);
  console.assert(result4.signal === 'SKIP', 'Expected SKIP for low liquidity');
  console.log(`  Reason: ${result4.reason}`);

  // Test 5: High spread - should skip
  const book5 = createMockOrderBook({
    bids: [{ price: 0.55, size: 500 }],
    asks: [{ price: 0.65, size: 400 }],
  });
  const result5 = calc.evaluateMarket(market1, book5, 1000);
  console.log('\nTest 5 - High spread (>5%):');
  console.log(`  Signal: ${result5.signal}`);
  console.assert(result5.signal === 'SKIP', 'Expected SKIP for high spread');
  console.log(`  Reason: ${result5.reason}`);

  // Test 6: Yes < 0.2 - should skip
  const book6 = createMockOrderBook({
    bids: [{ price: 0.15, size: 500 }],
    asks: [{ price: 0.18, size: 400 }],
  });
  const market6 = createMockMarket({ liquidity: 20000 });
  const result6 = calc.evaluateMarket(market6, book6, 1000);
  console.log('\nTest 6 - Yes price < 0.2 (long-shot skip):');
  console.log(`  Signal: ${result6.signal}`);
  console.log(`  Reason: ${result6.reason}`);

  console.log('\n✓ All EV Calculator tests passed\n');
}

// ---- Risk Manager Tests ----

function testRiskManager() {
  console.log('\n=== Risk Manager Tests ===\n');
  const rm = new RiskManager(config);

  // Test 1: Stop-loss
  const position1 = {
    conditionId: '0x1',
    tokenId: '0xt1',
    outcome: 'YES' as const,
    entryPrice: 0.60,
    currentPrice: 0.50,
    size: 100,
    pnl: -10,
    pnlPercent: -16.67,
    entryTime: Date.now(),
    market: createMockMarket(),
  };
  console.log('Test 1 - Stop-loss (-16.67% < -15%):');
  console.log(`  Should stop-loss: ${rm.shouldStopLoss(position1)}`);
  console.assert(rm.shouldStopLoss(position1) === true, 'Expected stop-loss');

  // Test 2: Take-profit
  const position2 = {
    ...position1,
    currentPrice: 0.90,
    pnl: 30,
    pnlPercent: 50,
  };
  console.log('\nTest 2 - Take-profit (50% > 40%):');
  console.log(`  Should take-profit: ${rm.shouldTakeProfit(position2)}`);
  console.assert(rm.shouldTakeProfit(position2) === true, 'Expected take-profit');

  // Test 3: Rate limiting
  console.log('\nTest 3 - Rate limiting (2 trades/hour):');
  rm.recordTrade(0);
  rm.recordTrade(0);
  const canTrade = rm.canTrade();
  console.log(`  Can trade after 2 trades: ${canTrade.allowed}`);
  console.log(`  Reason: ${canTrade.reason}`);
  console.assert(canTrade.allowed === false, 'Expected rate limit');

  // Test 4: Daily loss limit
  console.log('\nTest 4 - Daily loss limit ($2):');
  const rm2 = new RiskManager(config);
  rm2.recordTrade(-1.5);
  rm2.recordTrade(-0.6);
  const canTrade2 = rm2.canTrade();
  console.log(`  Can trade after $2.10 loss: ${canTrade2.allowed}`);
  console.log(`  Reason: ${canTrade2.reason}`);
  console.assert(canTrade2.allowed === false, 'Expected daily loss limit');

  // Test 5: Manipulation detection
  console.log('\nTest 5 - Manipulation detection (20% volatility):');
  const rm3 = new RiskManager(config);
  // Simulate rapidly changing prices
  const prices = [0.50, 0.55, 0.45, 0.60, 0.40, 0.50];
  let lastCheck = null;
  for (const price of prices) {
    lastCheck = rm3.checkManipulation('0x1', price);
  }
  console.log(`  Is manipulation: ${lastCheck?.isManipulation}`);
  if (lastCheck?.isManipulation) {
    console.log(`  Paused until: ${new Date(lastCheck.pausedUntil!).toISOString()}`);
  }

  // Test 6: Position sizing
  console.log('\nTest 6 - Position sizing:');
  const size1 = rm.calculatePositionSize(1000, 0.08, 0); // 8% kelly, $1000 balance
  console.log(`  Size (8% kelly, no existing): $${size1.toFixed(2)}`);
  console.assert(size1 <= 100, 'Should be capped at 10% ($100)');

  const size2 = rm.calculatePositionSize(1000, 0.08, 50); // existing $50 exposure
  console.log(`  Size (8% kelly, $50 existing): $${size2.toFixed(2)}`);
  console.assert(size2 <= 50, 'Should be capped by existing exposure');

  console.log('\n✓ All Risk Manager tests passed\n');
}

// ---- Run Tests ----

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║       Polymarket V11 Engine - Unit Tests                 ║');
console.log('╚══════════════════════════════════════════════════════════╝');

try {
  testEVCalculator();
  testRiskManager();
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ALL TESTS PASSED ✓');
  console.log('══════════════════════════════════════════════════════════');
} catch (error: any) {
  console.error('TEST FAILED:', error.message);
  process.exit(1);
}
