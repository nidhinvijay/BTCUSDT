export function createLiveBroker({ symbol, logger }) {
  const log = (msg) => logger.info(`[LIVE BROKER MOCK] [${symbol}] ${msg}`);

  return {
    placeLimitBuy(qty, price, meta = {}) {
      log(`Would place LIMIT BUY: qty=${qty}, price=${price}, reason=${meta.reason}`);
      // In real implementation, this would call Fyers/Binance API
      // For now, we return a dummy order ID
      return Promise.resolve({ id: `mock-live-buy-${Date.now()}` });
    },

    placeLimitSell(qty, price, meta = {}) {
      log(`Would place LIMIT SELL: qty=${qty}, price=${price}, reason=${meta.reason}`);
      return Promise.resolve({ id: `mock-live-sell-${Date.now()}` });
    },

    cancelOrder(orderId) {
      log(`Would cancel order: ${orderId}`);
      return Promise.resolve(true);
    },

    // Emergency close all for the auto-cut logic
    closeAll() {
      log(`Would CLOSE ALL positions immediately (Auto-Cut triggered)`);
      return Promise.resolve(true);
    }
  };
}
