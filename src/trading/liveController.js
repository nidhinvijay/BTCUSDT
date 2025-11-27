export function createLiveController({ paperPnlContext, liveBot, logger }) {
  let isLiveActive = false;

  const getTotalPnl = () => {
    const snapshot = paperPnlContext.getSnapshot();
    return snapshot.totalPnl;
  };

  const activateLive = () => {
    if (isLiveActive) return;
    isLiveActive = true;
    logger.info(`[LiveController] Paper PnL ${getTotalPnl().toFixed(2)} > 0. LIVE bot activated.`);
  };

  const deactivateLive = async () => {
    if (!isLiveActive) return;
    isLiveActive = false;
    logger.info(`[LiveController] Paper PnL ${getTotalPnl().toFixed(2)} <= 0. LIVE bot paused & flattening.`);
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
    const total = getTotalPnl();
    if (total > 0 && !isLiveActive) {
      activateLive();
    } else if (total <= 0 && isLiveActive) {
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
