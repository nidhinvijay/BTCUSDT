import { createSignalBus } from '../signals/signalBus.js';
import { createFSM } from '../trading/fsm.js';
import { createPaperBroker } from '../trading/paperBroker.js';
import { createLiveBroker } from '../trading/liveBroker.js';
import { createPnlContext } from '../trading/pnlContext.js';
import { createLiveCompositeBroker } from '../trading/liveCompositeBroker.js';
import { createLiveController } from '../trading/liveController.js';
import { startMarketStream } from '../exchange/marketStream.js';
import { upsertMachineState, readMachineState } from '../utils/stateStore.js';
import { resumeState } from '../utils/resumer.js';

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

function createSignalStateSnapshot(signalSymbolState) {
  return {
    buy: {
      display: signalSymbolState.buy.display,
      fyersSymbol: signalSymbolState.buy.fyersSymbol,
    },
    sell: {
      display: signalSymbolState.sell.display,
      fyersSymbol: signalSymbolState.sell.fyersSymbol,
    },
  };
}

export async function setupCryptoBot({ symbol, logger, liveGate }) {
  const { paper, live, liveController } = createBotStacks({
    symbol,
    logger,
    liveGate,
  });

  const signalSymbolState = {
    buy: { display: null, fyersSymbol: null, ltp: null },
    sell: { display: null, fyersSymbol: null, ltp: null },
  };

  if (resumeState({ paper, live }, symbol)) {
    logger.info(`[${symbol}] State resumed successfully.`);
  } else {
    logger.info(`[${symbol}] No saved state found, starting fresh.`);
  }
  liveController.onTick();

  const saveState = () => {
    const stateToSave = {
      paper: {
        fsm: paper.fsm.getState(),
        pnl: paper.pnlContext.getState(),
      },
      live: {
        fsm: live.fsm.getState(),
        pnl: live.pnlContext.getState(),
        isActive: liveController.isLiveActive(),
      },
      signalSymbolState: createSignalStateSnapshot(signalSymbolState),
      timestamp: Date.now(),
    };
    upsertMachineState(symbol, stateToSave);
  };

  setInterval(saveState, 60_000);

  paper.signalBus.onBuy((payload) => {
    logger.info(`[${symbol}] Immediate state save triggered by BUY signal`);
    liveController.forwardSignal('BUY', payload);
    saveState();
  });
  paper.signalBus.onSell((payload) => {
    logger.info(`[${symbol}] Immediate state save triggered by SELL signal`);
    liveController.forwardSignal('SELL', payload);
    saveState();
  });

  logger.info(`[${symbol}] Using Binance market data`);
  startMarketStream({
    symbol,
    onTick: (tick) => {
      const normalizedTick = {
        ltp: tick.ltp,
        ts: tick.ts || Date.now(),
        source: 'base',
      };
      paper.pnlContext.updateMarkPrice(normalizedTick.ltp);
      live.pnlContext.updateMarkPrice(normalizedTick.ltp);
      liveController.onTick();
      paper.fsm.onTick(normalizedTick);
      live.fsm.onTick(normalizedTick);
    },
    logger,
  });

  return {
    paper,
    live,
    controller: liveController,
    signalSymbolState,
    setInstrument: () => {},
  };
}
