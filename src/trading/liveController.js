export function createLiveController({ paperPnlContext, liveBot, logger, gateConfig = {} }) {
  const { enabled = true, threshold = 0 } = gateConfig;
  let isLiveActive = !enabled;

  if (!enabled) {
    logger.info('[LiveController] Gate disabled via config. LIVE bot always active.');
  }

  const getTotalPnl = () => {
    const snapshot = paperPnlContext.getSnapshot();
    return snapshot.totalPnl;
  };

  const activateLive = () => {
    if (isLiveActive) return;
    isLiveActive = true;
    logger.info(
      `[LiveController] Paper PnL ${getTotalPnl().toFixed(2)} > ${threshold.toFixed(
        2
      )}. LIVE bot activated.`
    );
  };

  const deactivateLive = async () => {
    if (!isLiveActive) return;
    isLiveActive = false;
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
    if (total > threshold && !isLiveActive) {
      activateLive();
    } else if (total <= threshold && isLiveActive) {
      deactivateLive();
    }
  };

  return {
    onTick() {
      evaluateGate();
    },
    forwardSignal(side) {
      if (!isLiveActive) return false;
      if (side === 'BUY') {
        liveBot.signalBus.emitBuy();
      } else if (side === 'SELL') {
        liveBot.signalBus.emitSell();
      }
      return true;
    },
    isLiveActive() {
      return isLiveActive;
    },
    forceDeactivate: deactivateLive
  };
}
