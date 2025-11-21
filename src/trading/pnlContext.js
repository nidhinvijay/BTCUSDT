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

  function getClosedTrades() {
    return trades.filter((t) => t.type === "CLOSE");
  }

  function calculateMetrics() {
    const closedTrades = getClosedTrades();
    const totalPnl = realizedPnl + getUnrealizedPnl();

    // Win rate
    const winningTrades = closedTrades.filter((t) => t.pnl > 0);
    const losingTrades = closedTrades.filter((t) => t.pnl < 0);
    const winRate =
      closedTrades.length > 0
        ? (winningTrades.length / closedTrades.length) * 100
        : 0;

    // Profit factor
    const totalWins = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLosses = Math.abs(
      losingTrades.reduce((sum, t) => sum + t.pnl, 0)
    );
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : 0;

    // Best and worst trades
    let bestTrade = 0;
    let worstTrade = 0;
    if (closedTrades.length > 0) {
      bestTrade = Math.max(...closedTrades.map((t) => t.pnl || 0));
      worstTrade = Math.min(...closedTrades.map((t) => t.pnl || 0));
    }

    // Average trade PnL
    const avgTradePnl =
      closedTrades.length > 0 ? realizedPnl / closedTrades.length : 0;

    // PnL percentage (relative to initial capital assumption: $1000)
    const initialCapital = 1000; // Default assumption
    const pnlPercentage = (totalPnl / initialCapital) * 100;

    return {
      winRate: Number(winRate.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      bestTrade: Number(bestTrade.toFixed(2)),
      worstTrade: Number(worstTrade.toFixed(2)),
      avgTradePnl: Number(avgTradePnl.toFixed(2)),
      pnlPercentage: Number(pnlPercentage.toFixed(2)),
      totalWins: Number(totalWins.toFixed(2)),
      totalLosses: Number(totalLosses.toFixed(2)),
      winCount: winningTrades.length,
      lossCount: losingTrades.length,
    };
  }

  function snapshot() {
    const unrealizedPnl = getUnrealizedPnl();
    const totalPnl = realizedPnl + unrealizedPnl;
    const metrics = calculateMetrics();

    return {
      symbol,
      positionQty,
      positionSide,
      avgPrice,
      lastPrice,
      realizedPnl: Number(realizedPnl.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      tradeCount,
      trades,
      metrics,
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
