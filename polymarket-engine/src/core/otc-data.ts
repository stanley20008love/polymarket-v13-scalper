// ============================================================================
// Polymarket V13 - OTC Desk Data Simulator
// ============================================================================
// Marketing101 Module: Simulates private OTC desk flow data
// In real operations, this would connect to private data feeds
// Currently simulates large block flow patterns that move BTC price

import { logger } from '../utils/logger';

export interface OTCFlow {
  timestamp: number;
  direction: 'BUY' | 'SELL';
  size: number;          // BTC amount
  price: number;         // Execution price
  venue: string;         // OTC venue identifier
  confidence: number;    // How confident we are this is real OTC flow
  impact: number;        // Estimated market impact
}

export interface OTCDeskSnapshot {
  buyFlow: number;       // Total buy flow in last 5 min (BTC)
  sellFlow: number;      // Total sell flow in last 5 min (BTC)
  netFlow: number;       // Net flow (positive = buying pressure)
  avgBuySize: number;    // Average OTC buy block size
  avgSellSize: number;   // Average OTC sell block size
  largeBlocks: OTCFlow[];// Recent large blocks (>10 BTC)
  confidence: number;    // Overall confidence in OTC data
  signal: 'BULL' | 'BEAR' | 'NEUTRAL';
  signalStrength: number;
  lastUpdate: number;
}

export class OTCDataEngine {
  private flowHistory: OTCFlow[] = [];
  private lastSnapshot: OTCDeskSnapshot | null = null;
  private simulatedFlows: OTCFlow[] = [];

  constructor() {
    this.generateSimulatedFlows();
  }

  /**
   * Generate simulated OTC flows based on current BTC market conditions
   * In production, this would ingest real OTC data from private APIs
   */
  private generateSimulatedFlows(): void {
    const venues = ['Cumberland', 'Genesis', 'Circle', 'Kraken OTC', 'B2C2'];
    const now = Date.now();

    // Generate 50 random OTC flows in the last 30 minutes
    for (let i = 0; i < 50; i++) {
      const timestamp = now - Math.random() * 30 * 60 * 1000;
      const direction = Math.random() > 0.5 ? 'BUY' : 'SELL';
      const size = this.sampleOTCSize();
      const price = 80000 + (Math.random() - 0.5) * 2000; // Simulated price

      this.simulatedFlows.push({
        timestamp,
        direction,
        size,
        price,
        venue: venues[Math.floor(Math.random() * venues.length)],
        confidence: 0.6 + Math.random() * 0.35,
        impact: size * 0.001, // Rough impact estimate
      });
    }

    this.simulatedFlows.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Sample OTC block size from realistic distribution
   * Most OTC trades are 1-50 BTC, with occasional 100+ BTC blocks
   */
  private sampleOTCSize(): number {
    const r = Math.random();
    if (r < 0.4) return 1 + Math.random() * 9;        // 1-10 BTC (40%)
    if (r < 0.7) return 10 + Math.random() * 40;      // 10-50 BTC (30%)
    if (r < 0.9) return 50 + Math.random() * 150;     // 50-200 BTC (20%)
    return 200 + Math.random() * 800;                   // 200-1000 BTC (10%)
  }

  /**
   * Get current OTC desk snapshot
   * Filters flows from last 5 minutes and computes aggregate metrics
   */
  getSnapshot(btcPrice: number, btcChange5m: number): OTCDeskSnapshot {
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;

    // Refresh simulated flows periodically
    if (this.simulatedFlows.length < 20 ||
        now - this.simulatedFlows[this.simulatedFlows.length - 1].timestamp > 60000) {
      // Add new flows
      const venues = ['Cumberland', 'Genesis', 'Circle', 'Kraken OTC', 'B2C2'];
      for (let i = 0; i < 5; i++) {
        const direction = Math.random() > 0.45 ? 'BUY' : 'SELL';
        // Bias flows toward current market direction
        const biasedDir = btcChange5m > 0.05
          ? (Math.random() > 0.3 ? 'BUY' : 'SELL')
          : btcChange5m < -0.05
            ? (Math.random() > 0.3 ? 'SELL' : 'BUY')
            : direction;

        this.simulatedFlows.push({
          timestamp: now - Math.random() * 60000,
          direction: biasedDir,
          size: this.sampleOTCSize(),
          price: btcPrice + (Math.random() - 0.5) * btcPrice * 0.001,
          venue: venues[Math.floor(Math.random() * venues.length)],
          confidence: 0.6 + Math.random() * 0.35,
          impact: 0,
        });
      }

      // Keep only recent flows
      this.simulatedFlows = this.simulatedFlows.filter(f => f.timestamp > now - 30 * 60 * 1000);
    }

    // Filter recent flows
    const recentFlows = this.simulatedFlows.filter(f => f.timestamp > fiveMinAgo);

    const buyFlows = recentFlows.filter(f => f.direction === 'BUY');
    const sellFlows = recentFlows.filter(f => f.direction === 'SELL');

    const buyFlow = buyFlows.reduce((s, f) => s + f.size, 0);
    const sellFlow = sellFlows.reduce((s, f) => s + f.size, 0);
    const netFlow = buyFlow - sellFlow;

    const avgBuySize = buyFlows.length > 0
      ? buyFlows.reduce((s, f) => s + f.size, 0) / buyFlows.length : 0;
    const avgSellSize = sellFlows.length > 0
      ? sellFlows.reduce((s, f) => s + f.size, 0) / sellFlows.length : 0;

    // Large blocks (>10 BTC)
    const largeBlocks = recentFlows
      .filter(f => f.size > 10)
      .sort((a, b) => b.size - a.size)
      .slice(0, 10);

    // Signal: net flow direction with magnitude
    const totalFlow = buyFlow + sellFlow;
    const flowRatio = totalFlow > 0 ? netFlow / totalFlow : 0;
    const signal = flowRatio > 0.15 ? 'BULL' : flowRatio < -0.15 ? 'BEAR' : 'NEUTRAL';
    const signalStrength = Math.min(1, Math.abs(flowRatio) * 3);

    this.lastSnapshot = {
      buyFlow,
      sellFlow,
      netFlow,
      avgBuySize,
      avgSellSize,
      largeBlocks,
      confidence: Math.min(0.95, recentFlows.length / 20),
      signal,
      signalStrength,
      lastUpdate: now,
    };

    return this.lastSnapshot;
  }

  /**
   * Get OTC flow prediction for next 5 minutes
   * Based on recent flow patterns and market conditions
   */
  predictNextFlow(btcPrice: number, btcChange5m: number): {
    predictedDirection: 'BUY' | 'SELL';
    predictedNetFlow: number;
    confidence: number;
  } {
    const snapshot = this.getSnapshot(btcPrice, btcChange5m);
    const predictedDirection = snapshot.netFlow > 0 ? 'BUY' : 'SELL';
    const predictedNetFlow = snapshot.netFlow * 0.7; // Decay factor
    const confidence = snapshot.confidence * snapshot.signalStrength;

    return { predictedDirection, predictedNetFlow, confidence };
  }
}
