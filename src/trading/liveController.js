export function createLiveController({ paperBot, liveBot, logger, gateConfig = {} }) {
  const { enabled = true, threshold = 0 } = gateConfig;
  let isLiveActive = !enabled;
  let isLiveActiveLong = !enabled;
  let isLiveActiveShort = !enabled;
  let lastLongGatePnl = null;
  let lastShortGatePnl = null;

  const paperPnlContext = paperBot.pnlContext;
  const paperFsm = paperBot.fsm;

  // Track Paper window instances at deactivation to prevent immediate re-promotion
  let lastDeactivationPaperWindows = {
    buyProfitWindowStartTs: null,
    sellProfitWindowStartTs: null
  };

  if (!enabled) {
    logger.info('[LiveController] Gate disabled via config. LIVE bot always active.');
  }

  const getSidePnls = () => {
    const snapshot = paperPnlContext.getSnapshot();
    return {
      long: snapshot.longTotalPnl ?? snapshot.totalPnl ?? 0,
      short: snapshot.shortTotalPnl ?? snapshot.totalPnl ?? 0
    };
  };

  const maybePromotePositionsToLive = (targetSide = null) => {
    try {
      const paperSnap = paperPnlContext.getSnapshot();
      const lastPrice = paperSnap.lastPrice;
      if (!Number.isFinite(lastPrice)) {
        logger.warn('[LiveController] Skipping LIVE promotion: no last price yet.');
        return;
      }

      const longPosPaper = paperFsm.getLongPosition();
      const shortPosPaper = paperFsm.getShortPosition();
      const longPosLive = liveBot.fsm.getLongPosition();
      const shortPosLive = liveBot.fsm.getShortPosition();

      // Estimate per-side PnL from snapshot
      let longPnl = 0;
      if (longPosPaper && longPosPaper.qty > 0) {
        const upnl = (lastPrice - longPosPaper.entryPrice) * longPosPaper.qty;
        const realized = paperSnap.longStats ? paperSnap.longStats.realizedPnl : 0;
        longPnl = realized + upnl;
      }

      let shortPnl = 0;
      if (shortPosPaper && shortPosPaper.qty > 0) {
        const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some((s) =>
          paperSnap.symbol.includes(s)
        );
        const upnl = isIndian
          ? (lastPrice - shortPosPaper.entryPrice) * shortPosPaper.qty
          : (shortPosPaper.entryPrice - lastPrice) * shortPosPaper.qty;
        const realized = paperSnap.shortStats ? paperSnap.shortStats.realizedPnl : 0;
        shortPnl = realized + upnl;
      }

      // Check if Paper is still in the same window instance as when we deactivated
      const paperState = paperFsm.getState();
      const longWindowSame = lastDeactivationPaperWindows.buyProfitWindowStartTs === paperState.buyProfitWindowStartTs;
      const shortWindowSame = lastDeactivationPaperWindows.sellProfitWindowStartTs === paperState.sellProfitWindowStartTs;

      const checkLong = !targetSide || targetSide === 'BUY';
      const checkShort = !targetSide || targetSide === 'SELL';

      // Promote CE (LONG) if open, non-negative, and LIVE is flat on that side
      if (
        checkLong &&
        longPosPaper &&
        longPosPaper.qty > 0 &&
        longPnl >= 0 &&
        (!longPosLive || longPosLive.qty <= 0)
      ) {
        // Don't promote if we're still in the same window instance
        if (longWindowSame && paperState.buyProfitWindowStartTs) {
          logger.info(
            { side: 'BUY', windowStartTs: paperState.buyProfitWindowStartTs },
            '[LiveController] Skipping LONG promotion - still in same Paper profit window'
          );
        } else {
          logger.info(
            { side: 'BUY', longPnl: longPnl.toFixed(2), lastPrice },
            '[LiveController] Promoting PAPER LONG to LIVE via synthetic BUY signal'
          );
          liveBot.signalBus.emitBuy({ source: 'Synthetic' });
        }
      }

      // Promote PE (SHORT) if open, non-negative, and LIVE is flat on that side
      if (
        checkShort &&
        shortPosPaper &&
        shortPosPaper.qty > 0 &&
        shortPnl >= 0 &&
        (!shortPosLive || shortPosLive.qty <= 0)
      ) {
        // Don't promote if we're still in the same window instance
        if (shortWindowSame && paperState.sellProfitWindowStartTs) {
          logger.info(
            { side: 'SELL', windowStartTs: paperState.sellProfitWindowStartTs },
            '[LiveController] Skipping SHORT promotion - still in same Paper profit window'
          );
        } else {
          logger.info(
            { side: 'SELL', shortPnl: shortPnl.toFixed(2), lastPrice },
            '[LiveController] Promoting PAPER SHORT to LIVE via synthetic SELL signal'
          );
          liveBot.signalBus.emitSell({ source: 'Synthetic' });
        }
      }
    } catch (err) {
      logger.error({ err }, '[LiveController] Failed during LIVE promotion from PAPER');
    }
  };

  const rememberWindow = (side) => {
    const paperState = paperFsm.getState();
    if (side === 'BUY') {
      lastDeactivationPaperWindows.buyProfitWindowStartTs =
        paperState.buyProfitWindowStartTs;
    } else if (side === 'SELL') {
      lastDeactivationPaperWindows.sellProfitWindowStartTs =
        paperState.sellProfitWindowStartTs;
    }
  };

  const activateSide = (side) => {
    if (!enabled) return;
    if (side === 'BUY') {
      if (isLiveActiveLong) return;
      isLiveActiveLong = true;
      if (!isLiveActive) {
        isLiveActive = true;
        logger.info(
          `[LiveController] LONG gate activated (threshold ${threshold.toFixed(2)})`
        );
      }
      maybePromotePositionsToLive('BUY');
    } else {
      if (isLiveActiveShort) return;
      isLiveActiveShort = true;
      if (!isLiveActive) {
        isLiveActive = true;
        logger.info(
          `[LiveController] SHORT gate activated (threshold ${threshold.toFixed(2)})`
        );
      }
      maybePromotePositionsToLive('SELL');
    }
  };

  const deactivateSide = async (side) => {
    if (!enabled) return;
    const isLongSide = side === 'BUY';
    if (isLongSide) {
      if (!isLiveActiveLong) return;
      isLiveActiveLong = false;
      rememberWindow('BUY');
      try {
        if (typeof liveBot.fsm.forceCloseLong === 'function') {
          liveBot.fsm.forceCloseLong('GATE_DEACTIVATE');
        }
      } catch (err) {
        logger.error({ err }, '[LiveController] Failed to close LONG during deactivation');
      }
    } else {
      if (!isLiveActiveShort) return;
      isLiveActiveShort = false;
      rememberWindow('SELL');
      try {
        if (typeof liveBot.fsm.forceCloseShort === 'function') {
          liveBot.fsm.forceCloseShort('GATE_DEACTIVATE');
        }
      } catch (err) {
        logger.error({ err }, '[LiveController] Failed to close SHORT during deactivation');
      }
    }
    if (!isLiveActiveLong && !isLiveActiveShort) {
      isLiveActive = false;
      logger.info('[LiveController] LIVE bot paused - both gates inactive.');
    }
  };

  const evaluateGate = () => {
    if (!enabled) {
      if (!isLiveActive) {
        isLiveActive = true;
      }
      return;
    }
    const { long, short } = getSidePnls();
    const crossedLongUp =
      long > threshold && (lastLongGatePnl === null || lastLongGatePnl <= threshold);
    const crossedShortUp =
      short > threshold && (lastShortGatePnl === null || lastShortGatePnl <= threshold);
    const crossedLongDown = long <= threshold && isLiveActiveLong;
    const crossedShortDown = short <= threshold && isLiveActiveShort;

    if (crossedLongUp) {
      activateSide('BUY');
    }
    if (crossedShortUp) {
      activateSide('SELL');
    }
    if (crossedLongDown) {
      deactivateSide('BUY');
    }
    if (crossedShortDown) {
      deactivateSide('SELL');
    }

    lastLongGatePnl = long;
    lastShortGatePnl = short;
  };

  return {
    onTick() {
      evaluateGate();
    },
    forwardSignal(side, payload = {}) {
      const gateActive =
        side === 'BUY' ? isLiveActiveLong : isLiveActiveShort;
      if (!gateActive) return false;
      if (side === 'BUY') {
        liveBot.signalBus.emitBuy(payload);
      } else if (side === 'SELL') {
        liveBot.signalBus.emitSell(payload);
      }
      return true;
    },
    isLiveActive() {
      return isLiveActiveLong || isLiveActiveShort;
    },
    forceDeactivate: () => {
      deactivateSide('BUY');
      deactivateSide('SELL');
    }
  };
}
