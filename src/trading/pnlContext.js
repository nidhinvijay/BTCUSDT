// src/trading/pnlContext.js
export function createPnlContext({ symbol }) {
  let positionQty = 0;
  let avgPrice = 0;
  let positionSide = null; // 'LONG' | 'SHORT' | null

  let lastPrice = null;
  let realizedPnl = 0;
  let tradeCount = 0;
  const trades = [];

  function getUnrealizedPnl() {
    if (lastPrice == null || positionQty === 0 || !positionSide) return 0;

    if (positionSide === "LONG") {
      // Long unrealized P&L: (current price - entry price) * qty
      return (lastPrice - avgPrice) * positionQty;
    } else if (positionSide === "SHORT") {
      // Short unrealized P&L: (entry price - current price) * qty
      return (avgPrice - lastPrice) * positionQty;
    }

    return 0;
  }

  function snapshot() {
    const unrealizedPnl = getUnrealizedPnl();
    return {
      symbol,
      positionQty,
      positionSide,
      avgPrice,
      lastPrice,
      realizedPnl,
      unrealizedPnl,
      totalPnl: realizedPnl + unrealizedPnl,
      tradeCount,
      trades,
    };
  }

  return {
    getOpenQty() {
      return positionQty;
    },

    getPositionSide() {
      return positionSide;
    },

    updateMarkPrice(price) {
      lastPrice = price;
      return snapshot();
    },

    getSnapshot() {
      return snapshot();
    },

    openPosition({ side, qty, price, meta = {} }) {
      if (side === "BUY") {
        // Opening LONG position
        if (positionSide === "SHORT") {
          console.warn(
            "[PnL] Warning: Opening LONG while SHORT position exists. This shouldn't happen."
          );
        }
        const totalCost = avgPrice * positionQty + price * qty;
        positionQty += qty;
        avgPrice = positionQty > 0 ? totalCost / positionQty : 0;
        positionSide = "LONG";

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "OPEN",
          side,
          qty,
          price,
          meta,
        });
      } else if (side === "SELL") {
        // Opening SHORT position
        if (positionSide === "LONG") {
          console.warn(
            "[PnL] Warning: Opening SHORT while LONG position exists. This shouldn't happen."
          );
        }
        const totalCost = avgPrice * positionQty + price * qty;
        positionQty += qty;
        avgPrice = positionQty > 0 ? totalCost / positionQty : 0;
        positionSide = "SHORT";

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "OPEN",
          side,
          qty,
          price,
          meta,
        });
      }
      return snapshot();
    },

    closePosition({ side, qty, price, meta = {} }) {
      if (side === "SELL" && positionSide === "LONG") {
        // Closing LONG with SELL
        if (qty > positionQty) qty = positionQty; // safety

        const pnl = (price - avgPrice) * qty;
        realizedPnl += pnl;
        positionQty -= qty;

        if (positionQty <= 0) {
          positionQty = 0;
          avgPrice = 0;
          positionSide = null;
        }

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "CLOSE",
          side,
          qty,
          price,
          pnl,
          meta,
        });
      } else if (side === "BUY" && positionSide === "SHORT") {
        // Closing SHORT with BUY
        if (qty > positionQty) qty = positionQty; // safety

        const pnl = (avgPrice - price) * qty;
        realizedPnl += pnl;
        positionQty -= qty;

        if (positionQty <= 0) {
          positionQty = 0;
          avgPrice = 0;
          positionSide = null;
        }

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "CLOSE",
          side,
          qty,
          price,
          pnl,
          meta,
        });
      }
      return snapshot();
    },
  };
}
