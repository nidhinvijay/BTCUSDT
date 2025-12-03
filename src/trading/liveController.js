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
    const lastPrice = snapshot.lastPrice;
    
    let longPnl = 0;
    const longPos = paperFsm.getLongPosition();
    if (longPos && longPos.qty > 0 && Number.isFinite(lastPrice)) {
       longPnl = (lastPrice - longPos.entryPrice) * longPos.qty;
    }

    let shortPnl = 0;
    const shortPos = paperFsm.getShortPosition();
    if (shortPos && shortPos.qty > 0 && Number.isFinite(lastPrice)) {
        const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some((s) =>
          snapshot.symbol.includes(s)
        );
        shortPnl = isIndian
          ? (lastPrice - shortPos.entryPrice) * shortPos.qty
          : (shortPos.entryPrice - lastPrice) * shortPos.qty;
    }

    return {
      long: longPnl,
      short: shortPnl
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
        // User requested to ignore cumulative PnL and only check if current strategy (position) is profitable
        // const realized = paperSnap.longStats ? paperSnap.longStats.realizedPnl : 0;
        longPnl = upnl; 
      }

      let shortPnl = 0;
      if (shortPosPaper && shortPosPaper.qty > 0) {
        const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some((s) =>
          paperSnap.symbol.includes(s)
        );
        const upnl = isIndian
          ? (lastPrice - shortPosPaper.entryPrice) * shortPosPaper.qty
          : (shortPosPaper.entryPrice - lastPrice) * shortPosPaper.qty;
        // User requested to ignore cumulative PnL and only check if current strategy (position) is profitable
        // const realized = paperSnap.shortStats ? paperSnap.shortStats.realizedPnl : 0;
        shortPnl = upnl;
      }

      // Check if Paper is still in the same window instance as when we deactivated
      const paperState = paperFsm.getState();
      const longWindowSame = lastDeactivationPaperWindows.buyProfitWindowStartTs === paperState.buyProfitWindowStartTs;
      const shortWindowSame = lastDeactivationPaperWindows.sellProfitWindowStartTs === paperState.sellProfitWindowStartTs;

      const checkLong = !targetSide || targetSide === 'BUY';
      const checkShort = !targetSide || targetSide === 'SELL';

      // Promote CE (LONG) if open, non-negative, and LIVE is flat on that side
      if (checkLong && longPosPaper && longPosPaper.qty > 0) {
         if (longPnl >= threshold && (!longPosLive || longPosLive.qty <= 0)) {
            // Don't promote if we're still in the same window instance
            if (longWindowSame && paperState.buyProfitWindowStartTs) {
              logger.info(
                { side: 'BUY', windowStartTs: paperState.buyProfitWindowStartTs },
                '[LiveController] Skipping LONG promotion - still in same Paper profit window'
              );
            } else {
              let sourceLabel = 'Synthetic';
              if (longPosPaper?.meta?.signalSource === 'Close + Re-entry') {
                  sourceLabel = 'Re-entry';
              }
              logger.info(
                { side: 'BUY', longPnl: longPnl.toFixed(2), lastPrice, source: sourceLabel },
                `[LiveController] Promoting PAPER LONG to LIVE via ${sourceLabel} BUY signal`
              );
              liveBot.signalBus.emitBuy({ source: sourceLabel });
            }
         } else {
             // Debug why not promoting
             if (longPnl < threshold) {
                 logger.debug({ longPnl, threshold }, '[LiveController] LONG PnL below threshold');
             }
             if (longPosLive && longPosLive.qty > 0) {
                 logger.debug('[LiveController] LIVE LONG already open');
             }
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
          let sourceLabel = 'Synthetic';
          if (shortPosPaper?.meta?.signalSource === 'Close + Re-entry') {
              sourceLabel = 'Re-entry';
          }
          logger.info(
            { side: 'SELL', shortPnl: shortPnl.toFixed(2), lastPrice, source: sourceLabel },
            `[LiveController] Promoting PAPER SHORT to LIVE via ${sourceLabel} SELL signal`
          );
          liveBot.signalBus.emitSell({ source: sourceLabel });
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
