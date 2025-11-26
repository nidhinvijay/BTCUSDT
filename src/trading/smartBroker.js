export function createSmartBroker({ paperBroker, liveBroker, pnlContext, logger }) {
  let isLiveActive = false;

  // --- CONFIGURATION ---
  // Change these values to adjust the Profit Target
  const CAPITAL_BASE = 100000;       // Assumed Capital in currency units (e.g., ₹1,00,000)
  const PROFIT_TARGET_PERCENT = 10;  // Target % to stop Live trading (e.g., 10%)
  // ---------------------

  function checkAutoSwitch() {
    // We use totalPnl (Realized + Unrealized) to determine the state
    const { totalPnl, liveStats, symbol } = pnlContext.getSnapshot();

    // 1. Check Session Profit Target (Indian Indices Only)
    // If we hit the target, we STOP Live trading to lock in profits for the day.
    const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'].some(s => symbol.includes(s));

    if (isIndian) {
      const targetAmount = CAPITAL_BASE * (PROFIT_TARGET_PERCENT / 100);

      // Check if we have hit the target
      if (liveStats && liveStats.realizedPnl >= targetAmount) {
        if (isLiveActive) {
          logger.info(`[SmartBroker] 🎯 Session Target Hit! (+${liveStats.realizedPnl.toFixed(2)}). Locking Profit.`);
          logger.info(`[SmartBroker] Deactivating LIVE mode for the rest of the session.`);
          isLiveActive = false;
          liveBroker.closeAll().catch(err => logger.error({ err }, "Failed to close live positions on target hit"));
        }
        // Prevent re-activation if target is hit
        return;
      }
    }

    // 2. Normal Auto-Switch Logic (Master/Slave)
    // "When first statemachine is above 0 we will start the second"
    // "if the first one goes below zero then second one will exit"
    if (totalPnl > 0 && !isLiveActive) {
      logger.info(`[SmartBroker] 🟢 PnL (${totalPnl.toFixed(2)}) > 0. Activating LIVE mode.`);
      isLiveActive = true;
    } else if (totalPnl <= 0 && isLiveActive) {
      logger.info(`[SmartBroker] 🔴 PnL (${totalPnl.toFixed(2)}) <= 0. Deactivating LIVE mode. Closing all LIVE positions.`);
      isLiveActive = false;
      liveBroker.closeAll().catch(err => logger.error({ err }, "Failed to close live positions"));
    }
  }

  return {
    placeLimitBuy(qty, price, meta = {}) {
      checkAutoSwitch(); // Ensure state is current before acting

      // Determine mode
      const mode = isLiveActive ? 'LIVE' : 'PAPER';
      const metaWithMode = { ...meta, mode };

      // Always execute on Paper (Master)
      const result = paperBroker.placeLimitBuy(qty, price, metaWithMode);

      // Mirror to Live (Slave) if active
      if (isLiveActive) {
        liveBroker.placeLimitBuy(qty, price, meta).catch(err =>
          logger.error({ err }, "Live Broker LimitBuy failed")
        );
      }

      return result;
    },

    placeLimitSell(qty, price, meta = {}) {
      checkAutoSwitch(); // Ensure state is current before acting

      // Determine mode
      const mode = isLiveActive ? 'LIVE' : 'PAPER';
      const metaWithMode = { ...meta, mode };

      // Always execute on Paper (Master)
      const result = paperBroker.placeLimitSell(qty, price, metaWithMode);

      // Mirror to Live (Slave) if active
      if (isLiveActive) {
        liveBroker.placeLimitSell(qty, price, meta).catch(err =>
          logger.error({ err }, "Live Broker LimitSell failed")
        );
      }

      return result;
    },

    cancelOrder(orderId) {
      return paperBroker.cancelOrder(orderId);
    },

    onTick() {
      checkAutoSwitch();
    },

    isLive() {
      return isLiveActive;
    }
  };
}
