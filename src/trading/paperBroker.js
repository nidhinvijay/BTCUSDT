// src/trading/paperBroker.js

export function createPaperBroker({ symbol, pnlContext, logger }) {
  return {
    placeLimitBuy(qty, price, meta = {}) {
      logger.info({ symbol, qty, price, meta }, "Paper LIMIT BUY");

      // Check if this is opening a LONG or closing a SHORT
      if (meta.reason && meta.reason.includes("OPEN")) {
        return pnlContext.openPosition({ side: "BUY", qty, price, meta });
      } else {
        return pnlContext.closePosition({ side: "BUY", qty, price, meta });
      }
    },

    placeLimitSell(qty, price, meta = {}) {
      logger.info({ symbol, qty, price, meta }, "Paper LIMIT SELL");

      // Check if this is opening a SHORT or closing a LONG
      if (meta.reason && meta.reason.includes("OPEN")) {
        return pnlContext.openPosition({ side: "SELL", qty, price, meta });
      } else {
        return pnlContext.closePosition({ side: "SELL", qty, price, meta });
      }
    },

    getOpenQty() {
      return pnlContext.getOpenQty();
    },
  };
}
