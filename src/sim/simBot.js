// src/sim/simBot.js
// Lightweight bot setup for simulation only.
// Uses the exact same FSM / PnL / broker logic as the live stack,
// but does NOT connect to Binance or Fyers.

import { createSignalBus } from '../signals/signalBus.js';
import { createFSM } from '../trading/fsm.js';
import { createPaperBroker } from '../trading/paperBroker.js';
import { createLiveBroker } from '../trading/liveBroker.js';
import { createPnlContext } from '../trading/pnlContext.js';
import { createLiveCompositeBroker } from '../trading/liveCompositeBroker.js';
import { createLiveController } from '../trading/liveController.js';

function createBotStacks({ symbol, logger, liveGate }) {
  const paper = {
    signalBus: createSignalBus(),
    pnlContext: createPnlContext({ symbol }),
  };
  paper.broker = createPaperBroker({
    symbol,
    pnlContext: paper.pnlContext,
    logger,
    modeLabel: 'PAPER',
  });
  paper.fsm = createFSM({
    symbol,
    signalBus: paper.signalBus,
    broker: paper.broker,
    pnlContext: paper.pnlContext,
    logger,
  });

  const live = {
    signalBus: createSignalBus(),
    pnlContext: createPnlContext({ symbol }),
  };
  const liveBookkeepingBroker = createPaperBroker({
    symbol,
    pnlContext: live.pnlContext,
    logger,
    modeLabel: 'LIVE',
  });
  const liveExecutionBroker = createLiveBroker({ symbol, logger });
  live.broker = createLiveCompositeBroker({
    executionBroker: liveExecutionBroker,
    bookkeepingBroker: liveBookkeepingBroker,
    logger,
  });
  live.fsm = createFSM({
    symbol,
    signalBus: live.signalBus,
    broker: live.broker,
    pnlContext: live.pnlContext,
    logger,
  });

  const liveController = createLiveController({
    paperBot: paper,
    liveBot: live,
    logger,
    gateConfig: liveGate,
  });

  return { paper, live, liveController };
}

export function setupSimBot({ symbol, logger, liveGate }) {
  const { paper, live, liveController } = createBotStacks({
    symbol,
    logger,
    liveGate,
  });

  const signalSymbolState = {
    buy: { display: null, fyersSymbol: null, ltp: null },
    sell: { display: null, fyersSymbol: null, ltp: null },
  };

  // For simulation we don't persist or resume state; everything starts fresh.

  return {
    paper,
    live,
    controller: liveController,
    signalSymbolState,
    // For options, we don't hook real instruments; sim ticks provide prices.
    setInstrument: () => {},
  };
}

