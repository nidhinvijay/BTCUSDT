// src/sim/index.js
// Standalone simulation entrypoint.
// Uses the same FSM / PnL logic as the main app,
// but does not connect to Binance or Fyers.

import '../config/env.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { startTradingViewServer, setWss } from '../signals/tradingviewServer.js';
import { setupSimBot } from './simBot.js';
import { WebSocketServer } from 'ws';
import http from 'http';

async function main() {
  logger.info('Starting Multi-Asset Simulator...');
  logger.info(`Simulated Symbols: ${config.symbols.join(', ')}`);

  const activeBots = new Map();

  // Build simulation bots for each configured symbol.
  for (const symbol of config.symbols) {
    logger.info(`[SIM] Initializing bot for ${symbol}...`);
    const bot = setupSimBot({
      symbol,
      logger,
      liveGate: config.liveGate,
    });
    activeBots.set(symbol, bot);
  }

  // Express app with existing webhook + dashboard routes
  const app = startTradingViewServer({
    activeBots,
    logger,
  });

  // Add simulation-only tick endpoint: POST /sim/tick
  app.post('/sim/tick', (req, res) => {
    try {
      const body = typeof req.body === 'string' ? req.body : '';
      let payload = {};
      if (body) {
        try {
          payload = JSON.parse(body);
        } catch {
          // ignore bad JSON; fall back to defaults
        }
      }

      const symbol = payload.symbol || config.defaultSymbol;
      const bot = activeBots.get(symbol);
      if (!bot) {
        return res.status(404).json({ error: 'Unknown symbol', symbol });
      }

      const ltp = Number(payload.ltp);
      if (!Number.isFinite(ltp)) {
        return res.status(400).json({ error: 'Invalid ltp' });
      }

      const source = payload.source || 'base';
      const tick = { ltp, ts: Date.now(), source };

      // Drive PnL + FSM for both stacks, mirroring live path.
      bot.paper.pnlContext.updateMarkPrice(ltp);
      bot.live.pnlContext.updateMarkPrice(ltp);
      bot.controller.onTick();
      bot.paper.fsm.onTick(tick);
      bot.live.fsm.onTick(tick);

      return res.json({ success: true, symbol, source, ltp });
    } catch (err) {
      logger.error({ err }, '[SIM] /sim/tick failed');
      return res.status(500).json({ error: 'sim tick failed' });
    }
  });

  const simPort = parseInt(process.env.SIM_PORT || '3100', 10);

  const server = http.createServer(app);

  // WebSocket Server for Dashboard Updates (same shape as main index)
  const wss = new WebSocketServer({ server });
  setWss(wss);

  wss.on('connection', (ws) => {
    logger.info('[SIM] Dashboard client connected via WebSocket');

    const buildPayload = (stack) => ({
      buyState: stack.fsm.getBuyState(),
      sellState: stack.fsm.getSellState(),
      pnl: stack.pnlContext.getSnapshot(),
      anchors: stack.fsm.getAnchors(),
      signalHistory: stack.fsm.getSignalHistory(),
      longPosition: stack.fsm.getLongPosition(),
      shortPosition: stack.fsm.getShortPosition(),
      ...stack.fsm.getState(),
    });

    const fullState = {};
    activeBots.forEach((bot, symbol) => {
      fullState[symbol] = {
        paper: buildPayload(bot.paper),
        live: buildPayload(bot.live),
        mode: bot.controller.isLiveActive() ? 'LIVE' : 'PAPER',
        signalSymbolBuy: null,
        signalSymbolSell: null,
      };
    });
    ws.send(JSON.stringify({ type: 'INIT', data: fullState }));

    const interval = setInterval(() => {
      const updates = {};
      activeBots.forEach((bot, symbol) => {
        updates[symbol] = {
          paper: buildPayload(bot.paper),
          live: buildPayload(bot.live),
          mode: bot.controller.isLiveActive() ? 'LIVE' : 'PAPER',
          signalSymbolBuy: null,
          signalSymbolSell: null,
        };
      });
      ws.send(JSON.stringify({ type: 'UPDATE', data: updates }));
    }, 1000);

    ws.on('close', () => clearInterval(interval));
  });

  server.listen(simPort, () => {
    logger.info(`[SIM] Simulator Webhook Server running on port ${simPort}`);
  });

  logger.info('[SIM] System initialized.');
}

main().catch((err) => {
  console.error('Fatal error in SIM main()', err);
  process.exit(1);
});

