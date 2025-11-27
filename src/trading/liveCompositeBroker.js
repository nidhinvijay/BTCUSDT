export function createLiveCompositeBroker({ executionBroker, bookkeepingBroker, logger }) {
  const execute = async (action, qty, price, meta) => {
    // Update local bookkeeping immediately so dashboard stays responsive.
    bookkeepingBroker[action](qty, price, meta);
    try {
      const execFn = executionBroker[action];
      if (typeof execFn === 'function') {
        return await execFn(qty, price, meta);
      }
    } catch (err) {
      logger.error({ err }, `[LiveComposite] ${action} failed on execution broker`);
      throw err;
    }
    return null;
  };

  return {
    placeLimitBuy(qty, price, meta = {}) {
      return execute('placeLimitBuy', qty, price, meta);
    },
    placeLimitSell(qty, price, meta = {}) {
      return execute('placeLimitSell', qty, price, meta);
    },
    cancelOrder(id) {
      if (executionBroker.cancelOrder) {
        return executionBroker.cancelOrder(id);
      }
      return Promise.resolve(false);
    },
    closeAll() {
      if (executionBroker.closeAll) {
        return executionBroker.closeAll();
      }
      return Promise.resolve(true);
    },
    closeLong() {
      if (executionBroker.closeLong) {
        return executionBroker.closeLong();
      }
      return Promise.resolve(true);
    },
    closeShort() {
      if (executionBroker.closeShort) {
        return executionBroker.closeShort();
      }
      return Promise.resolve(true);
    },
    isLive() {
      return true;
    }
  };
}
