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
  const isIndianIndex = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some((s) =>
    symbol.includes(s)
  );

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
  let lastBuyTick = null;
  let lastSellTick = null;
  let buyEntryWindowStartTs = null;
  let sellEntryWindowStartTs = null;
  let buyProfitWindowStartTs = null;
  let sellProfitWindowStartTs = null;

  const waitWindows = {
    BUY: { startTs: null, durationMs: null, source: null },
    SELL: { startTs: null, durationMs: null, source: null },
  };

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

  function getLastSideTick(side) {
    if (side === "BUY") {
      return lastBuyTick || lastTick;
    }
    return lastSellTick || lastTick;
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
    const meta = {
      symbol,
      ts,
      reason: reason || (isIndianIndex ? "OPEN_PE_LONG" : "OPEN_SHORT"),
      leg: isIndianIndex ? "PE" : "SHORT",
    };

    if (isIndianIndex) {
      // Indian index PUTs are traded long-only: BUY to open
      broker.placeLimitBuy(qty, price, meta);
      shortPosition = { side: "PE_LONG", qty, entryPrice: price, stop: null };
      logger.info({ price, qty }, "Opened PE LONG position (Indian index)");
    } else {
      // Default: true SHORT
      broker.placeLimitSell(qty, price, meta);
      shortPosition = { side: "SHORT", qty, entryPrice: price, stop: null };
      logger.info({ price, qty }, "Opened SHORT position");
    }
  }

  function closeShort(price, ts, reason) {
    if (!shortIsOpen()) {
      logger.warn(
        { shortPosition, reason },
        "Tried to close SHORT but no SHORT is open"
      );
      return;
    }

    const meta = {
      symbol,
      ts,
      reason: reason || (isIndianIndex ? "CLOSE_PE_LONG" : "CLOSE_SHORT"),
      leg: isIndianIndex ? "PE" : "SHORT",
    };

    if (isIndianIndex) {
      // Indian index PUTs: SELL to close long
      broker.placeLimitSell(shortPosition.qty, price, meta);
    } else {
      // Default: BUY to close short
      broker.placeLimitBuy(shortPosition.qty, price, meta);
    }

    const pnl = isIndianIndex
      ? (price - shortPosition.entryPrice) * shortPosition.qty
      : (shortPosition.entryPrice - price) * shortPosition.qty;
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

  function resetWaitWindow(side) {
    const slot = waitWindows[side];
    slot.startTs = null;
    slot.durationMs = null;
    slot.source = null;
  }

  function enterWaitWindow(side, remainingMs, source, tickTs) {
    const duration = Math.max(0, remainingMs);
    if (duration <= 0) {
      // Immediately finish WAIT_WINDOW
      finishWaitWindow(side, source, tickTs);
      return;
    }
    const slot = waitWindows[side];
    slot.startTs = tickTs;
    slot.durationMs = duration;
    slot.source = source;
    transitionTo(side, STATES.WAIT_WINDOW);
  }

  function finishWaitWindow(side, nowStateSource, ts) {
    // Called when WAIT_WINDOW has fully elapsed (or immediately if remaining <= 0)
    resetWaitWindow(side);
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
  }

  // --- Signal handlers ---

  function onBuySignal(payload = {}) {
    // New BUY signal received (TradingView side may be BUY/SELL in payload.action)
    const source = payload.source || 'TradingView';
    const tvSide = payload.action || 'BUY';

    // 1. Check if we are already LONG. If so, ignore per CE/PE spec.
    if (longIsOpen()) {
      logger.info({ source }, "BUY signal received while LONG is open - ignoring per spec.");
      return;
    }

    // 2. Start fresh for the new signal
    buySignalFirstTickPending = true;
    // Track signal in history
    const isLive = typeof broker.isLive === 'function' ? broker.isLive() : false;
    signalHistory.unshift({
      ts: Date.now(),
      side: tvSide,
      fsmSide: "BUY",
      state: buyState,
      isLive,
      source
    });
    logger.info({ historySize: signalHistory.length, latest: signalHistory[0] }, "Added BUY signal to history");
    transitionTo("BUY", STATES.BUYSIGNAL);
  }

  function onSellSignal(payload = {}) {
    // New SELL signal received
    const source = payload.source || 'TradingView';
    const tvSide = payload.action || 'SELL';

    // 1. Check if we are already SHORT. If so, force close to "Restart" logic.
    if (shortIsOpen()) {
      const sellTick = getLastSideTick("SELL");
      if (sellTick) {
        logger.info({ source }, "New SELL signal received while SHORT. Force closing old position.");
        closeShort(sellTick.ltp, sellTick.ts, "SIGNAL_OVERRIDE");
      } else {
        logger.warn({ source }, "New SELL signal received while SHORT, but no SELL tick to close with. Position remains open (risky).");
      }
    }

    // 2. Start fresh for the new signal
    sellSignalFirstTickPending = true;
    // Track signal in history
    const isLive = typeof broker.isLive === 'function' ? broker.isLive() : false;
    signalHistory.unshift({
      ts: Date.now(),
      side: tvSide,
      fsmSide: "SELL",
      state: sellState,
      isLive,
      source
    });
    logger.info({ historySize: signalHistory.length, latest: signalHistory[0] }, "Added SELL signal to history");
    transitionTo("SELL", STATES.SELLSIGNAL);
  }

  // --- Tick handlers for each state ---

  function handleBuySignalTick(tick) {
    if (!buySignalFirstTickPending) return;

    // For Indian indices, only accept ticks from option feed (not index)
    const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some(s => symbol.includes(s));
    if (isIndian && tick.source === 'base') {
      // Ignore index ticks when waiting for option tick
      return;
    }

    const { ltp, ts } = tick;

    savedBUYLTP = ltp;
    buyEntryTrigger = savedBUYLTP + 0.5;
    buyStop = savedBUYLTP - 0.5;

    buyEntryWindowStartTs = ts;
    buySignalFirstTickPending = false;
    buyEntryFirstTickPending = true;

    logger.info(
      { savedBUYLTP, buyEntryTrigger, buyStop, source: tick.source },
      "BUYSIGNAL first tick processed, entering BUYENTRY_WINDOW"
    );

    transitionTo("BUY", STATES.BUYENTRY_WINDOW);
  }

  function handleSellSignalTick(tick) {
    if (!sellSignalFirstTickPending) return;

    // For Indian indices, only accept ticks from option feed (not index)
    const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some(s => symbol.includes(s));
    if (isIndian && tick.source === 'base') {
      // Ignore index ticks when waiting for option tick
      return;
    }
    const { ltp, ts } = tick;

    savedSELLLTP = ltp;
    sellEntryTrigger = savedSELLLTP - 0.5;
    sellStop = savedSELLLTP + 0.5;

    sellEntryWindowStartTs = ts;
    sellSignalFirstTickPending = false;
    sellEntryFirstTickPending = true;

    logger.info(
      { savedSELLLTP, sellEntryTrigger, sellStop, source: tick.source },
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
      // Fix: If window already expired (negative remainingMs after restart), skip to next state
      if (remainingMs <= 0) {
        logger.info(
          { ltp, buyEntryTrigger },
          "BUYENTRY_WINDOW: expired on restart, moving to WAIT_FOR_BUYENTRY"
        );
        waitForBuyEntryStartTs = ts;
        waitForBuyEntryFirstTickSeen = false;
        transitionTo("BUY", STATES.WAIT_FOR_BUYENTRY);
      } else {
        logger.info(
          { ltp, buyEntryTrigger, remainingMs },
          "BUYENTRY_WINDOW: entry not hit, entering WAIT_WINDOW then back to BUYENTRY_WINDOW"
        );
        enterWaitWindow("BUY", remainingMs, "BUYENTRY_WINDOW", ts);
      }
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
      // Fix: If window already expired (negative remainingMs after restart), skip to next state
      if (remainingMs <= 0) {
        logger.info(
          { ltp, sellEntryTrigger },
          "SELLENTRY_WINDOW: expired on restart, moving to WAIT_FOR_SELLENTRY"
        );
        waitForSellEntryStartTs = ts;
        waitForSellEntryFirstTickSeen = false;
        transitionTo("SELL", STATES.WAIT_FOR_SELLENTRY);
      } else {
        logger.info(
          { ltp, sellEntryTrigger, remainingMs },
          "SELLENTRY_WINDOW: entry not hit, entering WAIT_WINDOW then back to SELLENTRY_WINDOW"
        );
        enterWaitWindow("SELL", remainingMs, "SELLENTRY_WINDOW", ts);
      }
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
      enterWaitWindow("BUY", remainingMs, "BUYPROFIT_WINDOW", ts);
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
      enterWaitWindow("SELL", remainingMs, "SELLPROFIT_WINDOW", ts);
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
  function handleWaitWindowTick(side, tick) {
    const slot = waitWindows[side];
    if (!slot.startTs || slot.durationMs == null || !slot.source) return;
    const { ts } = tick;
    const elapsed = ts - slot.startTs;
    if (elapsed >= slot.durationMs) {
      logger.info(
        { waitWindowSource: slot.source, side },
        "WAIT_WINDOW: duration completed, leaving WAIT_WINDOW"
      );
      const source = slot.source;
      resetWaitWindow(side);
      finishWaitWindow(side, source, ts);
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
    // tick: { ltp, ts, source } ts = ms
    if (isIndianIndex && tick?.source === 'base') {
      // For Indian indices, completely ignore underlying index ticks.
      // Only option contract feeds (buy/sell) should move the FSM.
      return;
    }

    lastTick = tick;
    const source = tick?.source || 'base';
    const canProcessBuy = source === 'buy' || source === 'base';
    const canProcessSell = source === 'sell' || source === 'base';

    if (source === 'buy') {
      lastBuyTick = tick;
    } else if (source === 'sell') {
      lastSellTick = tick;
    } else if (!isIndianIndex) {
      // Crypto/base instruments share the same feed for both sides
      lastBuyTick = tick;
      lastSellTick = tick;
    }

    // Process BUY FSM
    if (canProcessBuy) {
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
    }

    // Process SELL FSM (independent)
    if (canProcessSell) {
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
    }

    // Handle WAIT_WINDOW if either FSM uses it
    if (waitWindows.BUY.source) {
      handleWaitWindowTick("BUY", tick);
    }
    if (waitWindows.SELL.source) {
      handleWaitWindowTick("SELL", tick);
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
      waitWindows: {
        BUY: { ...waitWindows.BUY },
        SELL: { ...waitWindows.SELL },
      },
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
      logger.info({ restoredCount: signalHistory.length }, "Restored signal history");
    }

    buyEntryWindowStartTs = state.buyEntryWindowStartTs;
    sellEntryWindowStartTs = state.sellEntryWindowStartTs;
    buyProfitWindowStartTs = state.buyProfitWindowStartTs;
    sellProfitWindowStartTs = state.sellProfitWindowStartTs;

    if (state.waitWindows && state.waitWindows.BUY) {
      waitWindows.BUY.startTs = state.waitWindows.BUY.startTs ?? null;
      waitWindows.BUY.durationMs = state.waitWindows.BUY.durationMs ?? null;
      waitWindows.BUY.source = state.waitWindows.BUY.source ?? null;
    } else if (state.waitWindowSource && state.waitWindowSource.includes("BUY")) {
      waitWindows.BUY.startTs = state.waitWindowStartTs ?? null;
      waitWindows.BUY.durationMs = state.waitWindowDurationMs ?? null;
      waitWindows.BUY.source = state.waitWindowSource;
    } else {
      resetWaitWindow("BUY");
    }

    if (state.waitWindows && state.waitWindows.SELL) {
      waitWindows.SELL.startTs = state.waitWindows.SELL.startTs ?? null;
      waitWindows.SELL.durationMs = state.waitWindows.SELL.durationMs ?? null;
      waitWindows.SELL.source = state.waitWindows.SELL.source ?? null;
    } else if (state.waitWindowSource && state.waitWindowSource.includes("SELL")) {
      waitWindows.SELL.startTs = state.waitWindowStartTs ?? null;
      waitWindows.SELL.durationMs = state.waitWindowDurationMs ?? null;
      waitWindows.SELL.source = state.waitWindowSource;
    } else {
      resetWaitWindow("SELL");
    }

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
      let closed = false;

      if (longIsOpen()) {
        const tick = getLastSideTick("BUY");
        if (!tick) {
          logger.warn("Cannot manual close LONG: No BUY tick data available");
        } else {
          closeLong(tick.ltp, tick.ts, "MANUAL_OVERRIDE");
          closed = true;
        }
      }
      if (shortIsOpen()) {
        const tick = getLastSideTick("SELL");
        if (!tick) {
          logger.warn("Cannot manual close SHORT: No SELL tick data available");
        } else {
          closeShort(tick.ltp, tick.ts, "MANUAL_OVERRIDE");
          closed = true;
        }
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
        resetWaitWindow("BUY");
        resetWaitWindow("SELL");
        waitForBuyEntryStartTs = null;
        waitForSellEntryStartTs = null;
      }
      return closed;
    },
    forceCloseLong: (reason = "FORCE_CLOSE") => {
      if (!longIsOpen()) return false;
      const tick = getLastSideTick("BUY");
      if (!tick) {
        logger.warn("Cannot close LONG: No BUY tick data available");
        return false;
      }
      closeLong(tick.ltp, tick.ts, reason);
      buyEntryWindowStartTs = null;
      buyProfitWindowStartTs = null;
      waitForBuyEntryStartTs = null;
      waitForBuyEntryFirstTickSeen = false;
      resetWaitWindow("BUY");
      transitionTo("BUY", STATES.WAIT_FOR_SIGNAL);
      return true;
    },
    forceCloseShort: (reason = "FORCE_CLOSE") => {
      if (!shortIsOpen()) return false;
      const tick = getLastSideTick("SELL");
      if (!tick) {
        logger.warn("Cannot close SHORT: No SELL tick data available");
        return false;
      }
      closeShort(tick.ltp, tick.ts, reason);
      sellEntryWindowStartTs = null;
      sellProfitWindowStartTs = null;
      waitForSellEntryStartTs = null;
      waitForSellEntryFirstTickSeen = false;
      resetWaitWindow("SELL");
      transitionTo("SELL", STATES.WAIT_FOR_SIGNAL);
      return true;
    },
    reset() {
      buyState = STATES.WAIT_FOR_SIGNAL;
      sellState = STATES.WAIT_FOR_SIGNAL;
      savedBUYLTP = null;
      savedSELLLTP = null;
      buyEntryTrigger = null;
      buyStop = null;
      sellEntryTrigger = null;
      sellStop = null;
      longPosition = null;
      shortPosition = null;
      signalHistory.length = 0;
      lastTick = null;
      lastBuyTick = null;
      lastSellTick = null;
      buyEntryWindowStartTs = null;
      sellEntryWindowStartTs = null;
      buyProfitWindowStartTs = null;
      sellProfitWindowStartTs = null;
      resetWaitWindow("BUY");
      resetWaitWindow("SELL");
      waitForBuyEntryStartTs = null;
      waitForBuyEntryFirstTickSeen = false;
      waitForSellEntryStartTs = null;
      waitForSellEntryFirstTickSeen = false;
      buySignalFirstTickPending = false;
      sellSignalFirstTickPending = false;
      buyEntryFirstTickPending = false;
      sellEntryFirstTickPending = false;
      logger.info("FSM state reset to initial values. Signal history cleared.");
    }
  };
}
