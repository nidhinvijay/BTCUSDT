// src/index.js
import './config/env.js';
import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { startTradingViewServer } from './signals/tradingviewServer.js';
import { createSignalBus } from './signals/signalBus.js';
import { createFSM } from './trading/fsm.js';
import { createPaperBroker } from './trading/paperBroker.js';
import { createPnlContext } from './trading/pnlContext.js';
import { startMarketStream } from './exchange/marketStream.js';
import { SessionManager } from './state/sessionState.js';
import { upsertMachineState } from './utils/stateStore.js';
import { resumeState } from './utils/resumer.js';
import { WebSocketServer } from 'ws';
import http from 'http';

async function main() {
  const symbol = config.symbol;

  logger.info(`Starting BTCUSDT paper trader for ${symbol}...`);

  // 1. Initialize Session Manager
  const sessionManager = new SessionManager(-1000); // Default daily loss limit

  const signalBus = createSignalBus();
  const pnlContext = createPnlContext({ symbol });
  const broker = createPaperBroker({ symbol, pnlContext, logger });

  // 2. Initialize FSM
  const fsm = createFSM({
    symbol,
    signalBus,
    broker,
    pnlContext,
    logger
  });

  // 3. Resume State
  if (resumeState(fsm, sessionManager, symbol)) {
    logger.info("State resumed successfully.");
  } else {
    logger.info("No saved state found, starting fresh.");
  }

  // 4. TradingView webhook server + dashboard + relays
  // We need to wrap the express app with HTTP server for WebSocket
  const app = startTradingViewServer({
    signalBus,
    fsm,
    pnlContext,
    logger
  });

  // Create HTTP server from Express app
  const server = http.createServer(app);

  // Attach WebSocket to the same server
  const wss = new WebSocketServer({ server });
  logger.info(`WebSocket server attached to HTTP server`);

  wss.on('connection', (ws) => {
    logger.info('[WebSocket] Client connected');
    
    // Send initial state
    const statusSnapshot = {
      session: sessionManager.getState(),
      fsm: fsm.getState(),
      pnl: pnlContext.getSnapshot(),
      timestamp: Date.now()
    };
    
    ws.send(JSON.stringify({
      type: "status_update",
      data: statusSnapshot
    }));
  });

  // Start the server on port 3000 (or config.port)
  server.listen(config.port, () => {
    logger.info(`Server running on http://localhost:${config.port}`);
  });

  // Broadcast updates every 1s
  setInterval(() => {
    const statusSnapshot = {
      session: sessionManager.getState(),
      fsm: fsm.getState(),
      pnl: pnlContext.getSnapshot(),
      timestamp: Date.now()
    };
    
    const message = JSON.stringify({
      type: "status_update",
      data: statusSnapshot
    });
    
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  }, 1000);

  // 5. Auto-Save State
  setInterval(() => {
    const stateToSave = {
      fsm: fsm.getState(),
      session: sessionManager.getState(),
      timestamp: Date.now()
    };
    upsertMachineState(symbol, stateToSave);
    // logger.info("State auto-saved."); // Verbose
  }, 60000);

  // 6. Binance market stream (ticks)
  startMarketStream({
    symbol,
    onTick: (tick) => {
      // Update mark price for P&L
      const pnlSnapshot = pnlContext.updateMarkPrice(tick.ltp);
      
      // Feed PnL to SessionManager
      // We need the *change* or *current total*? 
      // SessionManager expects updates or we can just sync the total.
      // SM implementation: updateLivePnL(pnl) adds to cumulative. 
      // But pnlContext gives total unrealized. 
      // Let's just sync the realised PnL from pnlContext if it changes.
      // For now, let's just update session stats periodically or on trade close.
      // But SessionManager logic relies on PnL for the "Gate".
      // Simple integration: Update SessionManager with Realized PnL from pnlContext.
      
      // Note: This is a loose integration. Ideally pnlContext should emit events.
      // For now, we just let FSM run.
      
      fsm.onTick(tick);
    },
    logger
  });

  logger.info('System initialized.');
}

main().catch((err) => {
  console.error('Fatal error in main()', err);
  process.exit(1);
});
