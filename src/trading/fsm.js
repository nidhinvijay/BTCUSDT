// src/trading/fsm.js

const STATES = {
  WAIT_FOR_SIGNAL: 'WAIT_FOR_SIGNAL',
  BUYSIGNAL: 'BUYSIGNAL',
  SELLSIGNAL: 'SELLSIGNAL',
  BUYENTRY_WINDOW: 'BUYENTRY_WINDOW',
  SELLENTRY_WINDOW: 'SELLENTRY_WINDOW',
  BUYPROFIT_WINDOW: 'BUYPROFIT_WINDOW',
  SELLPROFIT_WINDOW: 'SELLPROFIT_WINDOW',
  WAIT_WINDOW: 'WAIT_WINDOW',
  WAIT_FOR_BUYENTRY: 'WAIT_FOR_BUYENTRY',
  WAIT_FOR_SELLENTRY: 'WAIT_FOR_SELLENTRY'
};

const WINDOW_MS = 60_000;

export function createFSM({ symbol, signalBus, broker, pnlContext, logger }) {
  // --- State machine core ---
  let state = STATES.WAIT_FOR_SIGNAL;

  // Anchors / triggers
  let savedBUYLTP = null;
  let savedSELLLTP = null;
  let buyEntryTrigger = null;
  let buyStop = null;
  let sellEntryTrigger = null;
  let sellStop = null;

  // Position tracking
  // side: 'LONG' | 'SHORT' | null
  let position = null; // { side, qty, entryPrice, stop }

  // Timestamps and flags
  let lastTick = null;

  let buyEntryWindowStartTs = null;
  let sellEntryWindowStartTs = null;
  let buyProfitWindowStartTs = null;
  let sellProfitWindowStartTs = null;

  let waitWindowStartTs = null;
  let waitWindowDurationMs = null;
  let waitWindowSource = null; // 'BUYENTRY_WINDOW' | 'SELLENTRY_WINDOW' | 'BUYPROFIT_WINDOW' | 'SELLPROFIT_WINDOW'

  let waitForBuyEntryStartTs = null;
  let waitForBuyEntryFirstTickSeen = false;

  let waitForSellEntryStartTs = null;
  let waitForSellEntryFirstTickSeen = false;

  let buySignalFirstTickPending = false;
  let sellSignalFirstTickPending = false;
  let buyEntryFirstTickPending = false;
  let sellEntryFirstTickPending = false;

  function transitionTo(next) {
    if (state !== next) {
      logger.info({ from: state, to: next }, 'FSM state transition');
      state = next;
    }
  }

  function positionIsOpen() {
    return !!position && position.qty > 0;
  }

  function computeOrderQty(price) {
    const notional = 25; // USD, simple fixed-size paper trade
    const qty = +(notional / price).toFixed(4);
    return qty || 0.001;
  }

  function openLong(price, ts, reason) {
    if (positionIsOpen()) {
      logger.warn({ position }, 'Tried to open LONG but position already open');
      return;
    }
    const qty = computeOrderQty(price);
    broker.placeLimitBuy(qty, price, { symbol, ts, reason: reason || 'OPEN_LONG' });
    position = { side: 'LONG', qty, entryPrice: price, stop: null };
    logger.info({ price, qty }, 'Opened LONG position');
  }

  function closeLong(price, ts, reason) {
    if (!positionIsOpen() || position.side !== 'LONG') {
      logger.warn({ position, reason }, 'Tried to close LONG but no LONG is open');
      return;
    }
    broker.placeLimitSell(position.qty, price, { symbol, ts, reason: reason || 'CLOSE_LONG' });
    const pnl = (price - position.entryPrice) * position.qty;
    logger.info({ closePrice: price, entryPrice: position.entryPrice, qty: position.qty, pnl, reason }, 'Closed LONG');
    position = null;
  }

  function openShort(price, ts, reason) {
    if (positionIsOpen()) {
      logger.warn({ position }, 'Tried to open SHORT but position already open');
      return;
    }
    const qty = computeOrderQty(price);
    broker.placeLimitSell(qty, price, { symbol, ts, reason: reason || 'OPEN_SHORT' });
    position = { side: 'SHORT', qty, entryPrice: price, stop: null };
    logger.info({ price, qty }, 'Opened SHORT position');
  }

  function closeShort(price, ts, reason) {
    if (!positionIsOpen() || position.side !== 'SHORT') {
      logger.warn({ position, reason }, 'Tried to close SHORT but no SHORT is open');
      return;
    }
    broker.placeLimitBuy(position.qty, price, { symbol, ts, reason: reason || 'CLOSE_SHORT' });
    const pnl = (position.entryPrice - price) * position.qty;
    logger.info({ closePrice: price, entryPrice: position.entryPrice, qty: position.qty, pnl, reason }, 'Closed SHORT');
    position = null;
  }

  // --- WAIT_WINDOW helpers ---

  function enterWaitWindow(remainingMs, source, tickTs) {
    const duration = Math.max(0, remainingMs);
    if (duration <= 0) {
      // Immediately finish WAIT_WINDOW
      finishWaitWindow(source, tickTs);
      return;
    }
    waitWindowStartTs = tickTs;
    waitWindowDurationMs = duration;
    waitWindowSource = source;
    transitionTo(STATES.WAIT_WINDOW);
  }

  function finishWaitWindow(nowStateSource, ts) {
    // Called when WAIT_WINDOW has fully elapsed (or immediately if remaining <= 0)
    // Decide next state based on who called WAIT_WINDOW originally
    switch (nowStateSource) {
      case 'BUYENTRY_WINDOW': {
        // Go back to BUYENTRY_WINDOW with same anchors, and wait for first tick there
        buyEntryFirstTickPending = true;
        transitionTo(STATES.BUYENTRY_WINDOW);
        break;
      }
      case 'SELLENTRY_WINDOW': {
        sellEntryFirstTickPending = true;
        transitionTo(STATES.SELLENTRY_WINDOW);
        break;
      }
      case 'BUYPROFIT_WINDOW': {
        // After WAIT_WINDOW from BUYPROFIT_WINDOW → WAIT_FOR_BUYENTRY (60s)
        waitForBuyEntryStartTs = ts ?? (lastTick ? lastTick.ts : Date.now());
        waitForBuyEntryFirstTickSeen = false;
        transitionTo(STATES.WAIT_FOR_BUYENTRY);
        break;
      }
      case 'SELLPROFIT_WINDOW': {
        // After WAIT_WINDOW from SELLPROFIT_WINDOW → WAIT_FOR_SELLENTRY (60s)
        waitForSellEntryStartTs = ts ?? (lastTick ? lastTick.ts : Date.now());
        waitForSellEntryFirstTickSeen = false;
        transitionTo(STATES.WAIT_FOR_SELLENTRY);
        break;
      }
      default: {
        logger.warn({ nowStateSource }, 'Unknown WAIT_WINDOW source, going to WAIT_FOR_SIGNAL');
        transitionTo(STATES.WAIT_FOR_SIGNAL);
      }
    }
    // Clear wait window meta
    waitWindowStartTs = null;
    waitWindowDurationMs = null;
    waitWindowSource = null;
  }

  // --- Signal handlers ---

  function onBuySignal() {
    // BUY signal only valid in WAIT_FOR_SIGNAL and WAIT_FOR_BUYENTRY
    if (state === STATES.WAIT_FOR_SIGNAL || state === STATES.WAIT_FOR_BUYENTRY) {
      buySignalFirstTickPending = true;
      transitionTo(STATES.BUYSIGNAL);
    } else {
      logger.info({ state }, 'Ignoring BUY signal in this state');
    }
  }

  function onSellSignal() {
    // SELL signal only valid in WAIT_FOR_SIGNAL and WAIT_FOR_SELLENTRY
    if (state === STATES.WAIT_FOR_SIGNAL || state === STATES.WAIT_FOR_SELLENTRY) {
      sellSignalFirstTickPending = true;
      transitionTo(STATES.SELLSIGNAL);
    } else {
      logger.info({ state }, 'Ignoring SELL signal in this state');
    }
  }

  // --- Tick handlers for each state ---

  function handleBuySignalTick(tick) {
    if (!buySignalFirstTickPending) return;
    const { ltp, ts } = tick;

    savedBUYLTP = ltp;
    buyEntryTrigger = savedBUYLTP + 0.5;
    buyStop = savedBUYLTP - 0.5;

    buyEntryWindowStartTs = ts;
    buySignalFirstTickPending = false;
    buyEntryFirstTickPending = true;

    logger.info(
      { savedBUYLTP, buyEntryTrigger, buyStop },
      'BUYSIGNAL first tick processed, entering BUYENTRY_WINDOW'
    );

    transitionTo(STATES.BUYENTRY_WINDOW);
  }

  function handleSellSignalTick(tick) {
    if (!sellSignalFirstTickPending) return;
    const { ltp, ts } = tick;

    savedSELLLTP = ltp;
    sellEntryTrigger = savedSELLLTP - 0.5;
    sellStop = savedSELLLTP + 0.5;

    sellEntryWindowStartTs = ts;
    sellSignalFirstTickPending = false;
    sellEntryFirstTickPending = true;

    logger.info(
      { savedSELLLTP, sellEntryTrigger, sellStop },
      'SELLSIGNAL first tick processed, entering SELLENTRY_WINDOW'
    );

    transitionTo(STATES.SELLENTRY_WINDOW);
  }

  // 3.4 BUYENTRY_WINDOW (updated spec)
  function handleBuyEntryWindowTick(tick) {
    if (!buyEntryFirstTickPending) return; // Only first tick matters
    buyEntryFirstTickPending = false;

    const { ltp, ts } = tick;
    const elapsed = buyEntryWindowStartTs != null ? ts - buyEntryWindowStartTs : 0;
    const remainingMs = WINDOW_MS - elapsed;

    if (ltp >= buyEntryTrigger) {
      // Open LONG and go to BUYPROFIT_WINDOW
      openLong(ltp, ts, 'BUYENTRY_TRIGGER_HIT');
      position.stop = buyStop;
      buyProfitWindowStartTs = ts;
      logger.info(
        { ltp, buyEntryTrigger, buyStop },
        'BUYENTRY_WINDOW: LONG opened, entering BUYPROFIT_WINDOW'
      );
      transitionTo(STATES.BUYPROFIT_WINDOW);
    } else {
      // Entry fails, WAIT_WINDOW then back to BUYENTRY_WINDOW
      logger.info(
        { ltp, buyEntryTrigger, remainingMs },
        'BUYENTRY_WINDOW: entry not hit, entering WAIT_WINDOW then back to BUYENTRY_WINDOW'
      );
      enterWaitWindow(remainingMs, 'BUYENTRY_WINDOW', ts);
    }
  }

  // 3.5 SELLENTRY_WINDOW (updated spec)
  function handleSellEntryWindowTick(tick) {
    if (!sellEntryFirstTickPending) return; // Only first tick matters
    sellEntryFirstTickPending = false;

    const { ltp, ts } = tick;
    const elapsed = sellEntryWindowStartTs != null ? ts - sellEntryWindowStartTs : 0;
    const remainingMs = WINDOW_MS - elapsed;

    if (ltp <= sellEntryTrigger) {
      // Open SHORT and go to SELLPROFIT_WINDOW
      openShort(ltp, ts, 'SELLENTRY_TRIGGER_HIT');
      position.stop = sellStop;
      sellProfitWindowStartTs = ts;
      logger.info(
        { ltp, sellEntryTrigger, sellStop },
        'SELLENTRY_WINDOW: SHORT opened, entering SELLPROFIT_WINDOW'
      );
      transitionTo(STATES.SELLPROFIT_WINDOW);
    } else {
      // Entry fails, WAIT_WINDOW then back to SELLENTRY_WINDOW
      logger.info(
        { ltp, sellEntryTrigger, remainingMs },
        'SELLENTRY_WINDOW: entry not hit, entering WAIT_WINDOW then back to SELLENTRY_WINDOW'
      );
      enterWaitWindow(remainingMs, 'SELLENTRY_WINDOW', ts);
    }
  }

  // 3.6 BUYPROFIT_WINDOW
  function handleBuyProfitWindowTick(tick) {
    if (!positionIsOpen() || position.side !== 'LONG') return;

    const { ltp, ts } = tick;
    const stop = position.stop ?? buyStop;
    const elapsed = buyProfitWindowStartTs != null ? ts - buyProfitWindowStartTs : 0;

    if (ltp <= stop) {
      // Hit stop-loss: close position, WAIT_WINDOW, then WAIT_FOR_BUYENTRY
      closeLong(ltp, ts, 'BUYPROFIT_STOP_HIT');
      const remainingMs = WINDOW_MS - elapsed;
      logger.info(
        { ltp, stop, remainingMs },
        'BUYPROFIT_WINDOW: stop hit, entering WAIT_WINDOW then WAIT_FOR_BUYENTRY'
      );
      enterWaitWindow(remainingMs, 'BUYPROFIT_WINDOW', ts);
      return;
    }

    // 60s profit window elapsed without hitting stop → restart 60s window
    if (elapsed >= WINDOW_MS) {
      buyProfitWindowStartTs = ts;
      logger.info('BUYPROFIT_WINDOW: 60s elapsed without stop, restarting profit window');
    }
  }

  // 3.7 SELLPROFIT_WINDOW
  function handleSellProfitWindowTick(tick) {
    if (!positionIsOpen() || position.side !== 'SHORT') return;

    const { ltp, ts } = tick;
    const stop = position.stop ?? sellStop;
    const elapsed = sellProfitWindowStartTs != null ? ts - sellProfitWindowStartTs : 0;

    if (ltp >= stop) {
      // Hit stop-loss: close, WAIT_WINDOW, then WAIT_FOR_SELLENTRY
      closeShort(ltp, ts, 'SELLPROFIT_STOP_HIT');
      const remainingMs = WINDOW_MS - elapsed;
      logger.info(
        { ltp, stop, remainingMs },
        'SELLPROFIT_WINDOW: stop hit, entering WAIT_WINDOW then WAIT_FOR_SELLENTRY'
      );
      enterWaitWindow(remainingMs, 'SELLPROFIT_WINDOW', ts);
      return;
    }

    if (elapsed >= WINDOW_MS) {
      sellProfitWindowStartTs = ts;
      logger.info('SELLPROFIT_WINDOW: 60s elapsed without stop, restarting profit window');
    }
  }

  // 3.8 WAIT_WINDOW
  function handleWaitWindowTick(tick) {
    if (!waitWindowStartTs || waitWindowDurationMs == null || !waitWindowSource) return;
    const { ts } = tick;
    const elapsed = ts - waitWindowStartTs;
    if (elapsed >= waitWindowDurationMs) {
      logger.info(
        { waitWindowSource },
        'WAIT_WINDOW: duration completed, leaving WAIT_WINDOW'
      );
      const source = waitWindowSource;
      // Clear first to avoid recursion confusion
      waitWindowStartTs = null;
      waitWindowDurationMs = null;
      waitWindowSource = null;
      finishWaitWindow(source, ts);
    }
  }

  // 3.9 WAIT_FOR_BUYENTRY
  function handleWaitForBuyEntryTick(tick) {
    const { ltp, ts } = tick;

    if (!waitForBuyEntryStartTs) {
      waitForBuyEntryStartTs = ts;
    }
    const elapsed = ts - waitForBuyEntryStartTs;

    if (!waitForBuyEntryFirstTickSeen) {
      waitForBuyEntryFirstTickSeen = true;

      if (ltp >= buyEntryTrigger) {
        openLong(ltp, ts, 'WAIT_FOR_BUYENTRY_TRIGGER_HIT');
        position.stop = buyStop;
        buyProfitWindowStartTs = ts;
        logger.info(
          { ltp, buyEntryTrigger, buyStop },
          'WAIT_FOR_BUYENTRY: LONG opened, entering BUYPROFIT_WINDOW'
        );
        transitionTo(STATES.BUYPROFIT_WINDOW);
        return;
      }
    }

    // 60s expiry → restart WAIT_FOR_BUYENTRY
    if (elapsed >= WINDOW_MS) {
      waitForBuyEntryStartTs = ts;
      waitForBuyEntryFirstTickSeen = false;
      logger.info('WAIT_FOR_BUYENTRY: 60s elapsed, restarting WAIT_FOR_BUYENTRY window');
    }
  }

  // 3.10 WAIT_FOR_SELLENTRY
  function handleWaitForSellEntryTick(tick) {
    const { ltp, ts } = tick;

    if (!waitForSellEntryStartTs) {
      waitForSellEntryStartTs = ts;
    }
    const elapsed = ts - waitForSellEntryStartTs;

    if (!waitForSellEntryFirstTickSeen) {
      waitForSellEntryFirstTickSeen = true;

      if (ltp <= sellEntryTrigger) {
        openShort(ltp, ts, 'WAIT_FOR_SELLENTRY_TRIGGER_HIT');
        position.stop = sellStop;
        sellProfitWindowStartTs = ts;
        logger.info(
          { ltp, sellEntryTrigger, sellStop },
          'WAIT_FOR_SELLENTRY: SHORT opened, entering SELLPROFIT_WINDOW'
        );
        transitionTo(STATES.SELLPROFIT_WINDOW);
        return;
      }
    }

    if (elapsed >= WINDOW_MS) {
      waitForSellEntryStartTs = ts;
      waitForSellEntryFirstTickSeen = false;
      logger.info('WAIT_FOR_SELLENTRY: 60s elapsed, restarting WAIT_FOR_SELLENTRY window');
    }
  }

  // --- Public tick entrypoint ---

  function onTick(tick) {
    // tick: { ltp, ts } ts = ms
    lastTick = tick;

    switch (state) {
      case STATES.BUYSIGNAL:
        handleBuySignalTick(tick);
        break;
      case STATES.SELLSIGNAL:
        handleSellSignalTick(tick);
        break;
      case STATES.BUYENTRY_WINDOW:
        handleBuyEntryWindowTick(tick);
        break;
      case STATES.SELLENTRY_WINDOW:
        handleSellEntryWindowTick(tick);
        break;
      case STATES.BUYPROFIT_WINDOW:
        handleBuyProfitWindowTick(tick);
        break;
      case STATES.SELLPROFIT_WINDOW:
        handleSellProfitWindowTick(tick);
        break;
      case STATES.WAIT_WINDOW:
        handleWaitWindowTick(tick);
        break;
      case STATES.WAIT_FOR_BUYENTRY:
        handleWaitForBuyEntryTick(tick);
        break;
      case STATES.WAIT_FOR_SELLENTRY:
        handleWaitForSellEntryTick(tick);
        break;
      case STATES.WAIT_FOR_SIGNAL:
      default:
        // Price ignored in WAIT_FOR_SIGNAL
        break;
    }
  }

  // Wire signals
  signalBus.onBuy(onBuySignal);
  signalBus.onSell(onSellSignal);

  logger.info({ state, symbol }, 'FSM initialized with updated spec');

  return {
    onTick,
    getState: () => state,
    getPosition: () => position,
    getAnchors: () => ({
      savedBUYLTP,
      savedSELLLTP,
      buyEntryTrigger,
      buyStop,
      sellEntryTrigger,
      sellStop
    })
  };
}
