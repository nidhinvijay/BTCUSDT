// src/trading/paperBroker.js

export function createPaperBroker({ symbol, pnlContext, logger, modeLabel = 'PAPER' }) {
  return {
    placeLimitBuy(qty, price, meta = {}) {
      const resolvedMeta = { ...meta, mode: meta.mode || modeLabel };
      logger.info({ symbol, qty, price, meta: resolvedMeta }, `${modeLabel} LIMIT BUY`);

      // Check if this is opening a LONG or closing a SHORT
      // Opening reasons: BUYENTRY_TRIGGER_HIT, WAIT_FOR_BUYENTRY_TRIGGER_HIT, or contains OPEN
      const isOpening =
        meta.reason &&
        (meta.reason.includes("TRIGGER_HIT") || meta.reason.includes("OPEN"));

      if (isOpening) {
        return pnlContext.openPosition({ side: "BUY", qty, price, mode: resolvedMeta.mode, meta: resolvedMeta });
      } else {
        return pnlContext.closePosition({ side: "BUY", qty, price, mode: resolvedMeta.mode, meta: resolvedMeta });
      }
    },

    placeLimitSell(qty, price, meta = {}) {
      const resolvedMeta = { ...meta, mode: meta.mode || modeLabel };
      logger.info({ symbol, qty, price, meta: resolvedMeta }, `${modeLabel} LIMIT SELL`);

      // Check if this is opening a SHORT or closing a LONG
      // Closing reasons: BUYPROFIT_STOP_HIT, SELLPROFIT_STOP_HIT, GATE_DEACTIVATE, TV_SELL_EXIT, or contains CLOSE
      const isClosing =
        meta.reason &&
        (meta.reason.includes("STOP_HIT") || 
         meta.reason.includes("CLOSE") || 
         meta.reason.includes("GATE_DEACTIVATE") ||
         meta.reason.includes("EXIT"));

      if (isClosing) {
        return pnlContext.closePosition({ side: "SELL", qty, price, mode: resolvedMeta.mode, meta: resolvedMeta });
      } else {
        return pnlContext.openPosition({ side: "SELL", qty, price, mode: resolvedMeta.mode, meta: resolvedMeta });
      }
    },

    getOpenQty() {
      return pnlContext.getOpenQty();
    },
  };
}
