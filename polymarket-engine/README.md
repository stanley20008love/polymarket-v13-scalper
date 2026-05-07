# Polymarket V11 Strategy Engine

Automated trading engine for Polymarket prediction markets with strict risk management.

## Strategy Parameters (V11)

| Parameter | Value | Description |
|-----------|-------|-------------|
| Min EV | >5% | Only enter trades with positive expected value >5% |
| Max Yes Price | <0.20 | Skip long-shot YES bets (avoid lottery bias) |
| Take Profit | 40% | Exit position at 40% gain |
| Stop Loss | 15% | Exit position at 15% loss |
| Kelly Fraction | 0.5 (Half-Kelly) | Conservative position sizing |
| Max Position | 10% | Single position capped at 10% of bankroll |
| Min Liquidity | >$10,000 | Only trade liquid markets |
| Max Spread | <5% | Avoid illiquid order books |
| Manipulation Guard | 20% volatility | Pause market if 20%+ price swing |
| Manipulation Pause | 60 minutes | How long to pause a flagged market |
| Max Trades/Hour | 2 | Rate limit to prevent overtrading |
| Max Daily Loss | $2 | Stop trading after $2 daily loss |

## Wallets

| Wallet | Address |
|--------|---------|
| Hub Public | 0x2F88715F35712C8627b7AF2Ead04baA4a449542c |
| Trading | 0x13642cdE3d64d9d79b4837920667D881f285e937 |
| Profit Recovery | 0xFe332cA54738CBa561518A3a458BA6eFFfc3636D |

## Architecture

```
src/
├── core/
│   ├── config.ts          # Configuration loader
│   ├── types.ts           # TypeScript type definitions
│   ├── ev-calculator.ts   # EV calculation + Kelly sizing
│   ├── risk-manager.ts    # SL/TP/Rate limits/Anti-manipulation
│   └── engine.ts          # Main strategy orchestrator
├── services/
│   └── polymarket-client.ts  # Polymarket API client
├── api/
│   └── server.ts          # REST API server
├── utils/
│   └── logger.ts          # Winston logger
└── main.ts                # Entry point
```

## Quick Start

```bash
# Setup
npm install

# Scan markets (no trading)
npm run scan

# Trade mode
npm run trade

# Monitor existing positions
npm run monitor
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | /api/state | Engine state |
| GET | /api/positions | Current positions |
| GET | /api/trades | Trade history |
| GET | /api/config | Strategy config |
| POST | /api/scan | Trigger scan |
| POST | /api/start | Start engine |
| POST | /api/stop | Stop engine |
# Auto-deploy trigger - V13.1 50U Mode
