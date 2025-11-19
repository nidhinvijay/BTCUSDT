// src/trading/paperBroker.js

export function createPaperBroker({ symbol, pnlContext, logger }) {
  return {
    placeLimitBuy(qty, price, meta = {}) {
      logger.info({ symbol, qty, price, meta }, "Paper LIMIT BUY");

      // Check if this is opening a LONG or closing a SHORT
      // Opening reasons: BUYENTRY_TRIGGER_HIT, WAIT_FOR_BUYENTRY_TRIGGER_HIT, or contains OPEN
      const isOpening =
        meta.reason &&
        (meta.reason.includes("TRIGGER_HIT") || meta.reason.includes("OPEN"));

      if (isOpening) {
        return pnlContext.openPosition({ side: "BUY", qty, price, meta });
      } else {
        return pnlContext.closePosition({ side: "BUY", qty, price, meta });
      }
    },

    placeLimitSell(qty, price, meta = {}) {
      logger.info({ symbol, qty, price, meta }, "Paper LIMIT SELL");

      // Check if this is opening a SHORT or closing a LONG
      // Closing reasons: BUYPROFIT_STOP_HIT, SELLPROFIT_STOP_HIT, or contains CLOSE
      const isClosing =
        meta.reason &&
        (meta.reason.includes("STOP_HIT") || meta.reason.includes("CLOSE"));

      if (isClosing) {
        return pnlContext.closePosition({ side: "SELL", qty, price, meta });
      } else {
        return pnlContext.openPosition({ side: "SELL", qty, price, meta });
      }
    },

    getOpenQty() {
      return pnlContext.getOpenQty();
    },
  };
}
