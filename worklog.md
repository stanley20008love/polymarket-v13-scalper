---
Task ID: 1
Agent: Main Agent
Task: Build and deploy Polymarket V13 BTC 5MIN Scalper with visualization dashboard

Work Log:
- Designed complete V13 Scalper architecture: Binance WS feed + Signal convergence engine + Trade store + Dashboard
- Wrote src/core/types.ts - Added V13 Scalper types (BtcTick, Kline5m, SignalNode, ConvergenceResult, ScalperTrade, ScalperPosition, ScalperState)
- Wrote src/core/config.ts - Added Scalper configuration (lag threshold, risk params, convergence settings)
- Wrote src/feeds/binance-ws.ts - Binance WebSocket client for BTC real-time price, 5M klines, depth data
- Wrote src/core/scalper.ts - BTC 5MIN Scalper engine with 5-signal force-graph convergence (momentum, volume, order flow, kline pattern, trend)
- Wrote src/storage/trade-store.ts - In-memory + JSON persistence trade store with auto-save
- Rewrote src/main.ts - Express server with REST API + dashboard serving + auto-start scalper
- Created public/dashboard.html - Professional trading terminal dashboard (dark theme, real-time updates, P&L chart, signal convergence, positions, trade history)
- Updated package.json to V13, Dockerfile with health check, zeabur.json
- Built TypeScript with zero errors
- Pushed to GitHub: stanley20008love/polymarket-v13-scalper
- Deployed to Zeabur on existing project (polymarket-v11 project, using domain polymarketv11bot.zeabur.app)
- Set environment variables: SCALPER_ENABLED, SCALPER_MODE, LAG_THRESHOLD, risk params
- Verified all endpoints working: /health, /api/state, /api/trades, /api/positions, /api/signals, /api/config
- Engine running in PAPER mode with Binance WebSocket connected, BTC price $81,039

Stage Summary:
- V13 Scalper Engine fully deployed and running on Zeabur
- Dashboard URL: https://polymarketv11bot.zeabur.app/
- GitHub: https://github.com/stanley20008love/polymarket-v13-scalper
- Engine: RUNNING, Mode: PAPER, Binance: Connected
- Signal convergence: 5 weighted signals analyzing every 5 seconds
- Risk management: 0.5% per-trade, 2% daily cap, -0.4% hard stop
- No trades yet (correctly waiting for >70% convergence + >0.3% CLOB lag)
