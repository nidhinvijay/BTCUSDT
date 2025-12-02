export function createLiveController({ paperBot, liveBot, logger, gateConfig = {} }) {
  const { enabled = true, threshold = 0 } = gateConfig;
  let isLiveActive = !enabled;
  let lastTotalPnl = null;

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

  const getTotalPnl = () => {
    const snapshot = paperPnlContext.getSnapshot();
    return snapshot.totalPnl;
  };

  const maybePromotePositionsToLive = () => {
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

      // Promote CE (LONG) if open, non-negative, and LIVE is flat on that side
      if (longPosPaper && longPosPaper.qty > 0 && longPnl >= 0 && (!longPosLive || longPosLive.qty <= 0)) {
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
      if (shortPosPaper && shortPosPaper.qty > 0 && shortPnl >= 0 && (!shortPosLive || shortPosLive.qty <= 0)) {
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

  const activateLive = (promoteFromPaper) => {
    if (isLiveActive) return;
    isLiveActive = true;
    logger.info(
      `[LiveController] Paper PnL ${getTotalPnl().toFixed(2)} > ${threshold.toFixed(
        2
      )}. LIVE bot activated.`
    );
    if (promoteFromPaper) {
      maybePromotePositionsToLive();
    }
  };

  const deactivateLive = async () => {
    if (!isLiveActive) return;
    isLiveActive = false;

    // Store current Paper window timestamps to prevent re-promotion during same window
    const paperState = paperFsm.getState();
    lastDeactivationPaperWindows = {
      buyProfitWindowStartTs: paperState.buyProfitWindowStartTs,
      sellProfitWindowStartTs: paperState.sellProfitWindowStartTs
    };

    logger.info(
      `[LiveController] Paper PnL ${getTotalPnl().toFixed(2)} <= ${threshold.toFixed(
        2
      )}. LIVE bot paused & flattening.`
    );
    try {
      liveBot.fsm.manualCloseAll();
      if (typeof liveBot.broker.closeAll === 'function') {
        await liveBot.broker.closeAll();
      }
    } catch (err) {
      logger.error({ err }, '[LiveController] Failed to close live positions during deactivation');
    }
  };

  const evaluateGate = () => {
    if (!enabled) {
      if (!isLiveActive) {
        isLiveActive = true;
      }
      return;
    }
    const total = getTotalPnl();
    const crossedUp = total > threshold && (lastTotalPnl === null || lastTotalPnl <= threshold);
    if (total > threshold && !isLiveActive) {
      activateLive(crossedUp);
    } else if (total <= threshold && isLiveActive) {
      deactivateLive();
    }
    lastTotalPnl = total;
  };

  return {
    onTick() {
      evaluateGate();
    },
    forwardSignal(side, payload = {}) {
      if (!isLiveActive) return false;
      if (side === 'BUY') {
        liveBot.signalBus.emitBuy(payload);
      } else if (side === 'SELL') {
        liveBot.signalBus.emitSell(payload);
      }
      return true;
    },
    isLiveActive() {
      return isLiveActive;
    },
    forceDeactivate: deactivateLive
  };
}
