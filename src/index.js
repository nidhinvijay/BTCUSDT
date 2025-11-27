// src/index.js

import './config/env.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { startTradingViewServer } from './signals/tradingviewServer.js';
import { createSignalBus } from './signals/signalBus.js';
import { createFSM } from './trading/fsm.js';
import { createPaperBroker } from './trading/paperBroker.js';
import { createLiveBroker } from './trading/liveBroker.js';
import { createPnlContext } from './trading/pnlContext.js';
import { startMarketStream } from './exchange/marketStream.js';
import { upsertMachineState } from './utils/stateStore.js';
import { resumeState } from './utils/resumer.js';
import { createLiveCompositeBroker } from './trading/liveCompositeBroker.js';
import { createLiveController } from './trading/liveController.js';
import { WebSocketServer } from 'ws';
import http from 'http';
import { startScheduler } from './utils/scheduler.js';
import { FyersAuth } from './brokers/fyersAuth.js';
import { startFyersStream } from './exchange/fyersStream.js';
import { subscribeToSymbol, getLastTick } from './exchange/fyersDataHub.js';
import { setWss } from './signals/tradingviewServer.js';

async function main() {
  logger.info(`Starting Multi-Asset Paper Trader...`);
  logger.info(`Active Symbols: ${config.symbols.join(', ')}`);

  // Initialize Fyers authentication if configured
  let fyersAuth = null;
  let fyersAccessToken = null;

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
        fyersAccessToken = fyersAuth.getToken();
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

    // 1. Initialize Paper bot stack
    const paper = {
      signalBus: createSignalBus(),
      pnlContext: createPnlContext({ symbol }),
    };
    paper.broker = createPaperBroker({ symbol, pnlContext: paper.pnlContext, logger, modeLabel: 'PAPER' });
    paper.fsm = createFSM({
      symbol,
      signalBus: paper.signalBus,
      broker: paper.broker,
      pnlContext: paper.pnlContext,
      logger
    });

    // 2. Initialize Live bot stack
    const live = {
      signalBus: createSignalBus(),
      pnlContext: createPnlContext({ symbol }),
    };
    const liveBookkeepingBroker = createPaperBroker({
      symbol,
      pnlContext: live.pnlContext,
      logger,
      modeLabel: 'LIVE'
    });
    const liveExecutionBroker = createLiveBroker({ symbol, logger });
    live.broker = createLiveCompositeBroker({
      executionBroker: liveExecutionBroker,
      bookkeepingBroker: liveBookkeepingBroker,
      logger
    });
    live.fsm = createFSM({
      symbol,
      signalBus: live.signalBus,
      broker: live.broker,
      pnlContext: live.pnlContext,
      logger
    });

    const liveController = createLiveController({
      paperPnlContext: paper.pnlContext,
      liveBot: live,
      logger,
      gateConfig: config.liveGate
    });

    // 3. Resume State
    let signalSymbolState = {
      buy: {
        display: null,
        fyersSymbol: null,
        ltp: null,
        unsubscribe: null,
      },
      sell: {
        display: null,
        fyersSymbol: null,
        ltp: null,
        unsubscribe: null,
      }
    };

    if (resumeState({ paper, live }, symbol)) {
      logger.info(`[${symbol}] State resumed successfully.`);
    } else {
      logger.info(`[${symbol}] No saved state found, starting fresh.`);
    }
    liveController.onTick();

    // 4. Auto-Save State & Immediate Save Helper
    const saveState = () => {
      const stateToSave = {
        paper: {
          fsm: paper.fsm.getState(),
          pnl: paper.pnlContext.getState()
        },
        live: {
          fsm: live.fsm.getState(),
          pnl: live.pnlContext.getState(),
          isActive: liveController.isLiveActive()
        },
        signalSymbolState: {
          buy: { display: signalSymbolState.buy.display, fyersSymbol: signalSymbolState.buy.fyersSymbol },
          sell: { display: signalSymbolState.sell.display, fyersSymbol: signalSymbolState.sell.fyersSymbol }
        },
        timestamp: Date.now()
      };
      upsertMachineState(symbol, stateToSave);
    };

    // Periodic Save
    setInterval(() => {
      saveState();
    }, 60000);

    // Immediate Save on Critical Events (Signals)
    paper.signalBus.onBuy(() => {
      logger.info(`[${symbol}] Immediate state save triggered by BUY signal`);
      liveController.forwardSignal('BUY');
      saveState();
    });
    paper.signalBus.onSell(() => {
      logger.info(`[${symbol}] Immediate state save triggered by SELL signal`);
      liveController.forwardSignal('SELL');
      saveState();
    });

    // 5. Market stream (conditional: Binance or Fyers)
    const exchange = config.exchangeMapping[symbol] || 'binance';

    const priceFeed = {
      active: 'base',
    };

    const feedPriceTick = (source, tick) => {
      if (!tick || typeof tick.ltp !== 'number') return;
      if (source !== priceFeed.active) return;
      const normalizedTick = { ltp: tick.ltp, ts: tick.ts || Date.now(), source };
      paper.pnlContext.updateMarkPrice(normalizedTick.ltp);
      live.pnlContext.updateMarkPrice(normalizedTick.ltp);
      liveController.onTick();
      paper.fsm.onTick(normalizedTick);
      live.fsm.onTick(normalizedTick);
    };

    const detachInstrument = (side) => {
      if (signalSymbolState[side].unsubscribe) {
        signalSymbolState[side].unsubscribe();
        signalSymbolState[side].unsubscribe = null;
      }
      signalSymbolState[side].display = null;
      signalSymbolState[side].fyersSymbol = null;
      signalSymbolState[side].ltp = null;
    };

    const subscribeInstrument = (side, info) => {
      detachInstrument(side);
      if (!info || !info.fyersSymbol) return;

      signalSymbolState[side].display = info.display || info.fyersSymbol;
      signalSymbolState[side].fyersSymbol = info.fyersSymbol;
      signalSymbolState[side].ltp = null;

      signalSymbolState[side].unsubscribe = subscribeToSymbol(info.fyersSymbol, (tick) => {
        signalSymbolState[side].ltp = tick.ltp;
        feedPriceTick(side, tick);
      });

      const cached = getLastTick(info.fyersSymbol);
      if (cached) {
        signalSymbolState[side].ltp = cached.ltp;
        feedPriceTick(side, cached);
      }
    };

    let setInstrument = (info) => {
      if (!info || !info.fyersSymbol) {
        detachInstrument('buy');
        detachInstrument('sell');
        priceFeed.active = 'base';
        return;
      }

      const intendedSide = info.optionType === 'PUT' ? 'sell' : 'buy';
      subscribeInstrument(intendedSide, info);
      priceFeed.active = intendedSide;
    };

    if (exchange === 'fyers') {
      // Fyers stream for Indian indices
      if (fyersAccessToken) {
        logger.info(`[${symbol}] Using Fyers market data`);

        startFyersStream({
          symbol,
          accessToken: fyersAccessToken,
          appId: config.fyers.appId,
          onTick: (tick) => {
            if (priceFeed.active === 'base') {
              feedPriceTick('base', tick);
            }
          },
          logger
        });
      } else {
        logger.warn(`[${symbol}] Skipping - Fyers token not available. Run: npm run auth`);
        continue; // Skip this symbol
      }
    } else {
      // Binance stream for crypto
      logger.info(`[${symbol}] Using Binance market data`);
      startMarketStream({
        symbol,
        onTick: (tick) => {
          const normalizedTick = { ltp: tick.ltp, ts: tick.ts || Date.now(), source: 'base' };
          paper.pnlContext.updateMarkPrice(normalizedTick.ltp);
          live.pnlContext.updateMarkPrice(normalizedTick.ltp);
          liveController.onTick();
          paper.fsm.onTick(normalizedTick);
          live.fsm.onTick(normalizedTick);
        },
        logger
      });

      setInstrument = () => {};
    }

    // Store in Map
    activeBots.set(symbol, {
      paper,
      live,
      controller: liveController,
      signalSymbolState,
      setInstrument,
    });
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
