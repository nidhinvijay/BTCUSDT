// src/trading/fsm.js
// DUAL FSM: Independent BUY and SELL state machines
// BUY FSM handles LONG positions
// SELL FSM handles SHORT positions
// Both can run simultaneously

const STATES = {
  WAIT_FOR_SIGNAL: "WAIT_FOR_SIGNAL",
  BUYSIGNAL: "BUYSIGNAL",
  SELLSIGNAL: "SELLSIGNAL",
  BUYENTRY_WINDOW: "BUYENTRY_WINDOW",
  SELLENTRY_WINDOW: "SELLENTRY_WINDOW",
  BUYPROFIT_WINDOW: "BUYPROFIT_WINDOW",
  SELLPROFIT_WINDOW: "SELLPROFIT_WINDOW",
  WAIT_WINDOW: "WAIT_WINDOW",
  WAIT_FOR_BUYENTRY: "WAIT_FOR_BUYENTRY",
  WAIT_FOR_SELLENTRY: "WAIT_FOR_SELLENTRY",
};

const WINDOW_MS = 60_000;

export function createFSM({ symbol, signalBus, broker, pnlContext, logger }) {
  // --- DUAL FSM: One for BUY (LONG), one for SELL (SHORT) ---
  let buyState = STATES.WAIT_FOR_SIGNAL;
  let sellState = STATES.WAIT_FOR_SIGNAL;

  // Anchors / triggers
  let savedBUYLTP = null;
  let savedSELLLTP = null;
  let buyEntryTrigger = null;
  let buyStop = null;
  let sellEntryTrigger = null;
  let sellStop = null;

  // Position tracking - TWO INDEPENDENT POSITIONS
  let longPosition = null; // { side: 'LONG', qty, entryPrice, stop }
  let shortPosition = null; // { side: 'SHORT', qty, entryPrice, stop }

  // Signal history (last 10 signals)
  const signalHistory = [];

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

  function transitionTo(side, next) {
    // side: 'BUY' or 'SELL'
    const oldState = side === "BUY" ? buyState : sellState;
    if (oldState !== next) {
      logger.info({ side, from: oldState, to: next }, "FSM state transition");
      if (side === "BUY") {
        buyState = next;
      } else {
        sellState = next;
      }
    }
  }

  function longIsOpen() {
    return longPosition && longPosition.qty > 0;
  }

  function shortIsOpen() {
    return shortPosition && shortPosition.qty > 0;
  }

  function computeOrderQty(price) {
    // Fixed quantity of 1 as per manager request for readable P&L
    return 1;
  }

  function openLong(price, ts, reason) {
    if (longIsOpen()) {
      logger.warn({ longPosition }, "Tried to open LONG but LONG already open");
      return;
    }
    const qty = computeOrderQty(price);
    broker.placeLimitBuy(qty, price, {
      symbol,
      ts,
      reason: reason || "OPEN_LONG",
    });
    longPosition = { side: "LONG", qty, entryPrice: price, stop: null };
    logger.info({ price, qty }, "Opened LONG position");
  }

  function closeLong(price, ts, reason) {
    if (!longIsOpen()) {
      logger.warn(
        { longPosition, reason },
        "Tried to close LONG but no LONG is open"
      );
      return;
    }
    broker.placeLimitSell(longPosition.qty, price, {
      symbol,
      ts,
      reason: reason || "CLOSE_LONG",
    });
    const pnl = (price - longPosition.entryPrice) * longPosition.qty;
    logger.info(
      {
        closePrice: price,
        entryPrice: longPosition.entryPrice,
        qty: longPosition.qty,
        pnl,
        reason,
      },
      "Closed LONG"
    );
    longPosition = null;
  }

  function openShort(price, ts, reason) {
    if (shortIsOpen()) {
      logger.warn(
        { shortPosition },
        "Tried to open SHORT but SHORT already open"
      );
      return;
    }
    const qty = computeOrderQty(price);
    broker.placeLimitSell(qty, price, {
      symbol,
      ts,
      reason: reason || "OPEN_SHORT",
    });
    shortPosition = { side: "SHORT", qty, entryPrice: price, stop: null };
    logger.info({ price, qty }, "Opened SHORT position");
  }

  function closeShort(price, ts, reason) {
    if (!shortIsOpen()) {
      logger.warn(
        { shortPosition, reason },
        "Tried to close SHORT but no SHORT is open"
      );
      return;
    }
    broker.placeLimitBuy(shortPosition.qty, price, {
      symbol,
      ts,
      reason: reason || "CLOSE_SHORT",
    });
    const pnl = (shortPosition.entryPrice - price) * shortPosition.qty;
    logger.info(
      {
        closePrice: price,
        entryPrice: shortPosition.entryPrice,
        qty: shortPosition.qty,
        pnl,
        reason,
      },
      "Closed SHORT"
    );
    shortPosition = null;
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
    // Determine which FSM this WAIT_WINDOW belongs to based on source
    const side = source.includes("BUY") ? "BUY" : "SELL";
    transitionTo(side, STATES.WAIT_WINDOW);
  }

  function finishWaitWindow(nowStateSource, ts) {
    // Called when WAIT_WINDOW has fully elapsed (or immediately if remaining <= 0)
    // Decide next state based on who called WAIT_WINDOW originally
    const side = nowStateSource.includes("BUY") ? "BUY" : "SELL";
    switch (nowStateSource) {
      case "BUYENTRY_WINDOW": {
        // Go back to BUYENTRY_WINDOW with same anchors, and wait for first tick there
        buyEntryFirstTickPending = true;
        transitionTo(side, STATES.BUYENTRY_WINDOW);
        break;
      }
      case "SELLENTRY_WINDOW": {
        sellEntryFirstTickPending = true;
        transitionTo(side, STATES.SELLENTRY_WINDOW);
        break;
      }
      case "BUYPROFIT_WINDOW": {
        // After WAIT_WINDOW from BUYPROFIT_WINDOW → WAIT_FOR_BUYENTRY (60s)
        waitForBuyEntryStartTs = ts ?? (lastTick ? lastTick.ts : Date.now());
        waitForBuyEntryFirstTickSeen = false;
        transitionTo(side, STATES.WAIT_FOR_BUYENTRY);
        break;
      }
      case "SELLPROFIT_WINDOW": {
        // After WAIT_WINDOW from SELLPROFIT_WINDOW → WAIT_FOR_SELLENTRY (60s)
        waitForSellEntryStartTs = ts ?? (lastTick ? lastTick.ts : Date.now());
        waitForSellEntryFirstTickSeen = false;
        transitionTo(side, STATES.WAIT_FOR_SELLENTRY);
        break;
      }
      default: {
        logger.warn(
          { nowStateSource },
          "Unknown WAIT_WINDOW source, going to WAIT_FOR_SIGNAL"
        );
        transitionTo(side, STATES.WAIT_FOR_SIGNAL);
      }
    }
    // Clear wait window meta
    waitWindowStartTs = null;
    waitWindowDurationMs = null;
    waitWindowSource = null;
  }

  // --- Signal handlers ---

  function onBuySignal() {
    // BUY signal can be accepted anytime - start fresh
    buySignalFirstTickPending = true;
    // Track signal in history
    signalHistory.unshift({
      ts: Date.now(),
      side: "BUY",
      state: buyState,
    });
    if (signalHistory.length > 10) signalHistory.pop();
    transitionTo("BUY", STATES.BUYSIGNAL);
  }

  function onSellSignal() {
    // SELL signal can be accepted anytime - start fresh
    sellSignalFirstTickPending = true;
    // Track signal in history
    signalHistory.unshift({
      ts: Date.now(),
      side: "SELL",
      state: sellState,
    });
    if (signalHistory.length > 10) signalHistory.pop();
    transitionTo("SELL", STATES.SELLSIGNAL);
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
      "BUYSIGNAL first tick processed, entering BUYENTRY_WINDOW"
    );

    transitionTo("BUY", STATES.BUYENTRY_WINDOW);
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
      "SELLSIGNAL first tick processed, entering SELLENTRY_WINDOW"
    );

    transitionTo("SELL", STATES.SELLENTRY_WINDOW);
  }

  // 3.4 BUYENTRY_WINDOW (updated spec)
  function handleBuyEntryWindowTick(tick) {
    if (!buyEntryFirstTickPending) return; // Only first tick matters
    buyEntryFirstTickPending = false;

    const { ltp, ts } = tick;
    const elapsed =
      buyEntryWindowStartTs != null ? ts - buyEntryWindowStartTs : 0;
    const remainingMs = WINDOW_MS - elapsed;

    if (ltp >= buyEntryTrigger) {
      // Open LONG and go to BUYPROFIT_WINDOW
      openLong(ltp, ts, "BUYENTRY_TRIGGER_HIT");
      longPosition.stop = buyStop;
      buyProfitWindowStartTs = ts;
      logger.info(
        { ltp, buyEntryTrigger, buyStop },
        "BUYENTRY_WINDOW: LONG opened, entering BUYPROFIT_WINDOW"
      );
      transitionTo("BUY", STATES.BUYPROFIT_WINDOW);
    } else {
      // Entry fails, WAIT_WINDOW then back to BUYENTRY_WINDOW
      logger.info(
        { ltp, buyEntryTrigger, remainingMs },
        "BUYENTRY_WINDOW: entry not hit, entering WAIT_WINDOW then back to BUYENTRY_WINDOW"
      );
      enterWaitWindow(remainingMs, "BUYENTRY_WINDOW", ts);
    }
  }

  // 3.5 SELLENTRY_WINDOW (updated spec)
  function handleSellEntryWindowTick(tick) {
    if (!sellEntryFirstTickPending) return; // Only first tick matters
    sellEntryFirstTickPending = false;

    const { ltp, ts } = tick;
    const elapsed =
      sellEntryWindowStartTs != null ? ts - sellEntryWindowStartTs : 0;
    const remainingMs = WINDOW_MS - elapsed;

    if (ltp <= sellEntryTrigger) {
      // Open SHORT and go to SELLPROFIT_WINDOW
      openShort(ltp, ts, "SELLENTRY_TRIGGER_HIT");
      shortPosition.stop = sellStop;
      sellProfitWindowStartTs = ts;
      logger.info(
        { ltp, sellEntryTrigger, sellStop },
        "SELLENTRY_WINDOW: SHORT opened, entering SELLPROFIT_WINDOW"
      );
      transitionTo("SELL", STATES.SELLPROFIT_WINDOW);
    } else {
      // Entry fails, WAIT_WINDOW then back to SELLENTRY_WINDOW
      logger.info(
        { ltp, sellEntryTrigger, remainingMs },
        "SELLENTRY_WINDOW: entry not hit, entering WAIT_WINDOW then back to SELLENTRY_WINDOW"
      );
      enterWaitWindow(remainingMs, "SELLENTRY_WINDOW", ts);
    }
  }

  // 3.6 BUYPROFIT_WINDOW
  function handleBuyProfitWindowTick(tick) {
    if (!longIsOpen()) return;

    const { ltp, ts } = tick;
    const stop = longPosition.stop ?? buyStop;
    const elapsed =
      buyProfitWindowStartTs != null ? ts - buyProfitWindowStartTs : 0;

    if (ltp <= stop) {
      // Hit stop-loss: close position, WAIT_WINDOW, then WAIT_FOR_BUYENTRY
      closeLong(ltp, ts, "BUYPROFIT_STOP_HIT");
      const remainingMs = WINDOW_MS - elapsed;
      logger.info(
        { ltp, stop, remainingMs },
        "BUYPROFIT_WINDOW: stop hit, entering WAIT_WINDOW then WAIT_FOR_BUYENTRY"
      );
      enterWaitWindow(remainingMs, "BUYPROFIT_WINDOW", ts);
      return;
    }

    // 60s profit window elapsed without hitting stop → restart 60s window
    if (elapsed >= WINDOW_MS) {
      buyProfitWindowStartTs = ts;
      logger.info(
        "BUYPROFIT_WINDOW: 60s elapsed without stop, restarting profit window"
      );
    }
  }

  // 3.7 SELLPROFIT_WINDOW
  function handleSellProfitWindowTick(tick) {
    if (!shortIsOpen()) return;

    const { ltp, ts } = tick;
    const stop = shortPosition.stop ?? sellStop;
    const elapsed =
      sellProfitWindowStartTs != null ? ts - sellProfitWindowStartTs : 0;

    if (ltp >= stop) {
      // Hit stop-loss: close, WAIT_WINDOW, then WAIT_FOR_SELLENTRY
      closeShort(ltp, ts, "SELLPROFIT_STOP_HIT");
      const remainingMs = WINDOW_MS - elapsed;
      logger.info(
        { ltp, stop, remainingMs },
        "SELLPROFIT_WINDOW: stop hit, entering WAIT_WINDOW then WAIT_FOR_SELLENTRY"
      );
      enterWaitWindow(remainingMs, "SELLPROFIT_WINDOW", ts);
      return;
    }

    if (elapsed >= WINDOW_MS) {
      sellProfitWindowStartTs = ts;
      logger.info(
        "SELLPROFIT_WINDOW: 60s elapsed without stop, restarting profit window"
      );
    }
  }

  // 3.8 WAIT_WINDOW
  function handleWaitWindowTick(tick) {
    if (!waitWindowStartTs || waitWindowDurationMs == null || !waitWindowSource)
      return;
    const { ts } = tick;
    const elapsed = ts - waitWindowStartTs;
    if (elapsed >= waitWindowDurationMs) {
      logger.info(
        { waitWindowSource },
        "WAIT_WINDOW: duration completed, leaving WAIT_WINDOW"
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
        openLong(ltp, ts, "WAIT_FOR_BUYENTRY_TRIGGER_HIT");
        longPosition.stop = buyStop;
        buyProfitWindowStartTs = ts;
        logger.info(
          { ltp, buyEntryTrigger, buyStop },
          "WAIT_FOR_BUYENTRY: LONG opened, entering BUYPROFIT_WINDOW"
        );
        transitionTo("BUY", STATES.BUYPROFIT_WINDOW);
        return;
      }
    }

    // 60s expiry → restart WAIT_FOR_BUYENTRY
    if (elapsed >= WINDOW_MS) {
      waitForBuyEntryStartTs = ts;
      waitForBuyEntryFirstTickSeen = false;
      logger.info(
        "WAIT_FOR_BUYENTRY: 60s elapsed, restarting WAIT_FOR_BUYENTRY window"
      );
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
        openShort(ltp, ts, "WAIT_FOR_SELLENTRY_TRIGGER_HIT");
        shortPosition.stop = sellStop;
        sellProfitWindowStartTs = ts;
        logger.info(
          { ltp, sellEntryTrigger, sellStop },
          "WAIT_FOR_SELLENTRY: SHORT opened, entering SELLPROFIT_WINDOW"
        );
        transitionTo("SELL", STATES.SELLPROFIT_WINDOW);
        return;
      }
    }

    if (elapsed >= WINDOW_MS) {
      waitForSellEntryStartTs = ts;
      waitForSellEntryFirstTickSeen = false;
      logger.info(
        "WAIT_FOR_SELLENTRY: 60s elapsed, restarting WAIT_FOR_SELLENTRY window"
      );
    }
  }

  // --- Public tick entrypoint ---
  // Handle BOTH FSMs in parallel

  function onTick(tick) {
    // tick: { ltp, ts } ts = ms
    lastTick = tick;

    // Process BUY FSM
    switch (buyState) {
      case STATES.BUYSIGNAL:
        handleBuySignalTick(tick);
        break;
      case STATES.BUYENTRY_WINDOW:
        handleBuyEntryWindowTick(tick);
        break;
      case STATES.BUYPROFIT_WINDOW:
        handleBuyProfitWindowTick(tick);
        break;
      case STATES.WAIT_FOR_BUYENTRY:
        handleWaitForBuyEntryTick(tick);
        break;
    }

    // Process SELL FSM (independent)
    switch (sellState) {
      case STATES.SELLSIGNAL:
        handleSellSignalTick(tick);
        break;
      case STATES.SELLENTRY_WINDOW:
        handleSellEntryWindowTick(tick);
        break;
      case STATES.SELLPROFIT_WINDOW:
        handleSellProfitWindowTick(tick);
        break;
      case STATES.WAIT_FOR_SELLENTRY:
        handleWaitForSellEntryTick(tick);
        break;
    }

    // Handle WAIT_WINDOW if either FSM uses it
    if (waitWindowSource) {
      handleWaitWindowTick(tick);
    }
  }

  // Wire signals
  signalBus.onBuy(onBuySignal);
  signalBus.onSell(onSellSignal);

  logger.info(
    { buyState, sellState, symbol },
    "FSM initialized with DUAL (independent BUY/SELL) spec"
  );

  // --- Persistence ---
  
  function getState() {
    return {
      buyState,
      sellState,
      savedBUYLTP,
      savedSELLLTP,
      buyEntryTrigger,
      buyStop,
      sellEntryTrigger,
      sellStop,
      longPosition,
      shortPosition,
      signalHistory,
      // Timers
      buyEntryWindowStartTs,
      sellEntryWindowStartTs,
      buyProfitWindowStartTs,
      sellProfitWindowStartTs,
      waitWindowStartTs,
      waitWindowDurationMs,
      waitWindowSource,
      waitForBuyEntryStartTs,
      waitForBuyEntryFirstTickSeen,
      waitForSellEntryStartTs,
      waitForSellEntryFirstTickSeen,
      buySignalFirstTickPending,
      sellSignalFirstTickPending,
      buyEntryFirstTickPending,
      sellEntryFirstTickPending,
    };
  }

  function restoreState(state) {
    if (!state) return;
    logger.info({ state }, "Restoring FSM state...");
    
    buyState = state.buyState || STATES.WAIT_FOR_SIGNAL;
    sellState = state.sellState || STATES.WAIT_FOR_SIGNAL;
    
    savedBUYLTP = state.savedBUYLTP;
    savedSELLLTP = state.savedSELLLTP;
    buyEntryTrigger = state.buyEntryTrigger;
    buyStop = state.buyStop;
    sellEntryTrigger = state.sellEntryTrigger;
    sellStop = state.sellStop;
    
    longPosition = state.longPosition;
    shortPosition = state.shortPosition;
    
    if (state.signalHistory) {
      signalHistory.length = 0;
      signalHistory.push(...state.signalHistory);
    }

    buyEntryWindowStartTs = state.buyEntryWindowStartTs;
    sellEntryWindowStartTs = state.sellEntryWindowStartTs;
    buyProfitWindowStartTs = state.buyProfitWindowStartTs;
    sellProfitWindowStartTs = state.sellProfitWindowStartTs;
    
    waitWindowStartTs = state.waitWindowStartTs;
    waitWindowDurationMs = state.waitWindowDurationMs;
    waitWindowSource = state.waitWindowSource;
    
    waitForBuyEntryStartTs = state.waitForBuyEntryStartTs;
    waitForBuyEntryFirstTickSeen = state.waitForBuyEntryFirstTickSeen;
    
    waitForSellEntryStartTs = state.waitForSellEntryStartTs;
    waitForSellEntryFirstTickSeen = state.waitForSellEntryFirstTickSeen;
    
    buySignalFirstTickPending = state.buySignalFirstTickPending;
    sellSignalFirstTickPending = state.sellSignalFirstTickPending;
    buyEntryFirstTickPending = state.buyEntryFirstTickPending;
    sellEntryFirstTickPending = state.sellEntryFirstTickPending;
  }

  return {
    onTick,
    getBuyState: () => buyState,
    getSellState: () => sellState,
    getLongPosition: () => longPosition,
    getShortPosition: () => shortPosition,
    getSignalHistory: () => signalHistory,
    getAnchors: () => ({
      savedBUYLTP,
      savedSELLLTP,
      buyEntryTrigger,
      buyStop,
      sellEntryTrigger,
      sellStop,
    }),
    getState,
    restoreState,
    manualCloseAll: () => {
      if (!lastTick) {
        logger.warn("Cannot manual close: No tick data available yet");
        return false;
      }
      const { ltp, ts } = lastTick;
      let closed = false;
      
      if (longIsOpen()) {
        closeLong(ltp, ts, "MANUAL_OVERRIDE");
        closed = true;
      }
      if (shortIsOpen()) {
        closeShort(ltp, ts, "MANUAL_OVERRIDE");
        closed = true;
      }
      
      // Reset states to WAIT_FOR_SIGNAL to stop any pending windows
      if (closed) {
        transitionTo("BUY", STATES.WAIT_FOR_SIGNAL);
        transitionTo("SELL", STATES.WAIT_FOR_SIGNAL);
        // Clear all windows
        buyEntryWindowStartTs = null;
        sellEntryWindowStartTs = null;
        buyProfitWindowStartTs = null;
        sellProfitWindowStartTs = null;
        waitWindowStartTs = null;
        waitForBuyEntryStartTs = null;
        waitForSellEntryStartTs = null;
      }
      return closed;
    }
  };
}
