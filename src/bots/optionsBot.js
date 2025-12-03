import { createSignalBus } from '../signals/signalBus.js';
import { createFSM } from '../trading/fsm.js';
import { createPaperBroker } from '../trading/paperBroker.js';
import { createLiveBroker } from '../trading/liveBroker.js';
import { createPnlContext } from '../trading/pnlContext.js';
import { createLiveCompositeBroker } from '../trading/liveCompositeBroker.js';
import { createLiveController } from '../trading/liveController.js';
import { startFyersStream } from '../exchange/fyersStream.js';
import { subscribeToSymbol, getLastTick } from '../exchange/fyersDataHub.js';
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

export async function setupOptionsBot({
  symbol,
  logger,
  liveGate,
  fyersAuth,
  fyersConfig,
}) {
  if (!fyersAuth || !fyersAuth.isAuthenticated()) {
    logger.warn(
      `[${symbol}] Skipping - Fyers token not available. Run: npm run auth`,
    );
    return null;
  }

  const { paper, live, liveController } = createBotStacks({
    symbol,
    logger,
    liveGate,
  });

  const signalSymbolState = {
    buy: { display: null, fyersSymbol: null, ltp: null, unsubscribe: null },
    sell: { display: null, fyersSymbol: null, ltp: null, unsubscribe: null },
  };

  const priceFeed = { active: 'base' };

  const feedPriceTick = (source, tick) => {
    if (!tick || typeof tick.ltp !== 'number') return;
    if (source !== priceFeed.active) return;
    const normalizedTick = {
      ltp: tick.ltp,
      ts: tick.ts || Date.now(),
      source,
    };
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

    signalSymbolState[side].unsubscribe = subscribeToSymbol(
      info.fyersSymbol,
      (tick) => {
        signalSymbolState[side].ltp = tick.ltp;
        feedPriceTick(side, tick);
      },
    );

    const cached = getLastTick(info.fyersSymbol);
    if (cached) {
      signalSymbolState[side].ltp = cached.ltp;
      feedPriceTick(side, cached);
    }
  };

  const setInstrument = (info) => {
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

  if (resumeState({ paper, live }, symbol)) {
    logger.info(`[${symbol}] State resumed successfully.`);
    const savedState = readMachineState(symbol);
    if (savedState?.signalSymbolState) {
      if (savedState.signalSymbolState.buy?.fyersSymbol) {
        signalSymbolState.buy.display =
          savedState.signalSymbolState.buy.display;
        signalSymbolState.buy.fyersSymbol =
          savedState.signalSymbolState.buy.fyersSymbol;
        logger.info(
          {
            symbol: savedState.signalSymbolState.buy.display,
            fyersSymbol: savedState.signalSymbolState.buy.fyersSymbol,
          },
          '[State Resume] Restored BUY option subscription',
        );
      }
      if (savedState.signalSymbolState.sell?.fyersSymbol) {
        signalSymbolState.sell.display =
          savedState.signalSymbolState.sell.display;
        signalSymbolState.sell.fyersSymbol =
          savedState.signalSymbolState.sell.fyersSymbol;
        logger.info(
          {
            symbol: savedState.signalSymbolState.sell.display,
            fyersSymbol: savedState.signalSymbolState.sell.fyersSymbol,
          },
          '[State Resume] Restored SELL option subscription',
        );
      }
    }
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

  logger.info(`[${symbol}] Using Fyers market data`);
  startFyersStream({
    symbol,
    accessToken: () => fyersAuth.getToken(),
    appId: fyersConfig.appId,
    onTick: (tick) => {
      if (priceFeed.active === 'base') {
        feedPriceTick('base', tick);
      }
    },
    logger,
  });

  setTimeout(() => {
    const longPos = paper.fsm.getLongPosition();
    const shortPos = paper.fsm.getShortPosition();
    let activeSide = null;
    if (longPos && longPos.qty > 0) {
      activeSide = 'buy';
    } else if (shortPos && shortPos.qty > 0) {
      activeSide = 'sell';
    }
    if (activeSide && signalSymbolState[activeSide]?.fyersSymbol) {
      subscribeInstrument(activeSide, {
        fyersSymbol: signalSymbolState[activeSide].fyersSymbol,
        display: signalSymbolState[activeSide].display,
      });
      priceFeed.active = activeSide;
      logger.info(
        {
          side: activeSide,
          fyersSymbol: signalSymbolState[activeSide].fyersSymbol,
        },
        '[State Resume] Re-subscribed to option contract for open position',
      );
    }
  }, 2000);

  return {
    paper,
    live,
    controller: liveController,
    signalSymbolState,
    setInstrument,
  };
}
