// src/index.js

import './config/env.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { startTradingViewServer } from './signals/tradingviewServer.js';
import { WebSocketServer } from 'ws';
import http from 'http';
import { startScheduler } from './utils/scheduler.js';
import { FyersAuth } from './brokers/fyersAuth.js';
import { setWss } from './signals/tradingviewServer.js';
import { setupCryptoBot } from './bots/cryptoBot.js';
import { setupOptionsBot } from './bots/optionsBot.js';

async function main() {
  logger.info(`Starting Multi-Asset Paper Trader...`);
  logger.info(`Active Symbols: ${config.symbols.join(', ')}`);

  // Initialize Fyers authentication if configured
  let fyersAuth = null;

  if (config.fyers.enabled) {
    try {
      fyersAuth = new FyersAuth({
        appId: config.fyers.appId,
        secretKey: config.fyers.secretKey,
        redirectUri: config.fyers.redirectUri,
        pin: config.fyers.pin,
        logger
      });

      await fyersAuth.initialize();

      if (fyersAuth.isAuthenticated()) {
        logger.info('✅ Fyers authenticated - Indian indices will use live data');
      } else {
        logger.warn('⚠️ Fyers not authenticated. Run: npm run auth');
        logger.warn('Indian indices (NIFTY/BANKNIFTY/SENSEX) will be skipped');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Fyers auth');
    }
  } else {
    logger.info('ℹ️ Fyers not configured - only BTCUSDT will work');
  }

  // Map to store all active bots
  // Key: Symbol (e.g., 'BTCUSDT')
  // Value: { fsm, signalBus, pnlContext, sessionManager }
  const activeBots = new Map();

  // Initialize a Bot for each symbol
  for (const symbol of config.symbols) {
    logger.info(`Initializing bot for ${symbol}...`);

    const exchange = config.exchangeMapping[symbol] || 'binance';
    let bot = null;
    if (exchange === 'binance') {
      bot = await setupCryptoBot({
        symbol,
        logger,
        liveGate: config.liveGate,
      });
    } else if (exchange === 'fyers') {
      bot = await setupOptionsBot({
        symbol,
        logger,
        liveGate: config.liveGate,
        fyersAuth,
        fyersConfig: config.fyers,
      });
    }

    if (!bot) continue;

    activeBots.set(symbol, bot);
  }

  // 6. Start Scheduler (5:30 AM Reset)
  startScheduler(activeBots);

  // 7. TradingView webhook server + dashboard + relays
  // Pass the entire map of bots to the server
  const app = startTradingViewServer({
    activeBots, // Pass the Map instead of single instances
    logger
  });

  const server = http.createServer(app);

  // WebSocket Server for Dashboard Updates
  const wss = new WebSocketServer({ server });
  // Inject WSS into TradingView Server for signal broadcasting
  setWss(wss);

  wss.on('connection', (ws) => {
    logger.info('Dashboard client connected via WebSocket');

    const buildPayload = (stack) => ({
      buyState: stack.fsm.getBuyState(),
      sellState: stack.fsm.getSellState(),
      pnl: stack.pnlContext.getSnapshot(),
      anchors: stack.fsm.getAnchors(),
      signalHistory: stack.fsm.getSignalHistory(),
      longPosition: stack.fsm.getLongPosition(),
      shortPosition: stack.fsm.getShortPosition(),
      ...stack.fsm.getState()
    });

    // Send initial state for ALL symbols
    const fullState = {};
    activeBots.forEach((bot, symbol) => {
      const buyState = bot.signalSymbolState?.buy?.fyersSymbol
        ? {
          symbol: bot.signalSymbolState.buy.display,
          fyersSymbol: bot.signalSymbolState.buy.fyersSymbol,
          ltp: bot.signalSymbolState.buy.ltp,
        }
        : null;
      const sellState = bot.signalSymbolState?.sell?.fyersSymbol
        ? {
          symbol: bot.signalSymbolState.sell.display,
          fyersSymbol: bot.signalSymbolState.sell.fyersSymbol,
          ltp: bot.signalSymbolState.sell.ltp,
        }
        : null;
      fullState[symbol] = {
        paper: buildPayload(bot.paper),
        live: buildPayload(bot.live),
        mode: bot.controller.isLiveActive() ? 'LIVE' : 'PAPER',
        signalSymbolBuy: buyState,
        signalSymbolSell: sellState,
      };
    });
    ws.send(JSON.stringify({ type: 'INIT', data: fullState }));

    // Send updates periodically
    const interval = setInterval(() => {
      const updates = {};
      activeBots.forEach((bot, symbol) => {
        const buyState = bot.signalSymbolState?.buy?.fyersSymbol
          ? {
            symbol: bot.signalSymbolState.buy.display,
            fyersSymbol: bot.signalSymbolState.buy.fyersSymbol,
            ltp: bot.signalSymbolState.buy.ltp,
          }
          : null;
        const sellState = bot.signalSymbolState?.sell?.fyersSymbol
          ? {
            symbol: bot.signalSymbolState.sell.display,
            fyersSymbol: bot.signalSymbolState.sell.fyersSymbol,
            ltp: bot.signalSymbolState.sell.ltp,
          }
          : null;
        updates[symbol] = {
          paper: buildPayload(bot.paper),
          live: buildPayload(bot.live),
          mode: bot.controller.isLiveActive() ? 'LIVE' : 'PAPER',
          signalSymbolBuy: buyState,
          signalSymbolSell: sellState,
        };
      });
      ws.send(JSON.stringify({ type: 'UPDATE', data: updates }));
    }, 1000);

    ws.on('close', () => clearInterval(interval));
  });

  server.listen(config.port, () => {
    logger.info(`TradingView Webhook Server running on port ${config.port}`);
  });

  logger.info('System initialized.');
}

main().catch((err) => {
  console.error('Fatal error in main()', err);
  process.exit(1);
});
