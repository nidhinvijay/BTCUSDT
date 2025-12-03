// src/trading/pnlContext.js
export function createPnlContext({ symbol }) {
  // Independent positions
  let longPosition = { qty: 0, avgPrice: 0, mode: null };
  let shortPosition = { qty: 0, avgPrice: 0, mode: null };

  let lastPrice = null;
  let realizedPnl = 0;
  // Lifetime PnL removed as per user request
  let tradeCount = 0;
  const trades = [];

  // Split Stats
  let longStats = { realizedPnl: 0, tradeCount: 0 };
  let shortStats = { realizedPnl: 0, tradeCount: 0 };

  // Live Stats (Subset of trades executed in LIVE mode)
  let liveStats = { realizedPnl: 0, tradeCount: 0 };

  const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some(s => symbol.includes(s));

  function calculateUnrealizedBreakdown() {
    if (lastPrice == null) return { longUpnl: 0, shortUpnl: 0 };

    let longUpnl = 0;
    if (longPosition.qty > 0) {
      longUpnl = (lastPrice - longPosition.avgPrice) * longPosition.qty;
    }

    let shortUpnl = 0;
    if (shortPosition.qty > 0) {
      if (isIndian) {
        shortUpnl = (lastPrice - shortPosition.avgPrice) * shortPosition.qty;
      } else {
        shortUpnl = (shortPosition.avgPrice - lastPrice) * shortPosition.qty;
      }
    }

    return { longUpnl, shortUpnl };
  }

  function getUnrealizedPnl() {
    const { longUpnl, shortUpnl } = calculateUnrealizedBreakdown();
    return longUpnl + shortUpnl;
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

    // PnL percentage
    // For Indian indices, we align with the SmartBroker capital base (100,000)
    // For Crypto, we keep the default 1,000 assumption.
    const isIndian = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some(s => symbol.includes(s));
    const initialCapital = isIndian ? 100000 : 1000;

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
    const { longUpnl, shortUpnl } = calculateUnrealizedBreakdown();
    const unrealizedPnl = longUpnl + shortUpnl;
    const totalPnl = realizedPnl + unrealizedPnl;
    const longTotal = longStats.realizedPnl + longUpnl;
    const shortTotal = shortStats.realizedPnl + shortUpnl;
    const metrics = calculateMetrics();

    return {
      symbol,
      // We expose a summary "positionQty" for backward compatibility if needed,
      // but ideally consumers should check longPosition/shortPosition if they need details.
      // Net Position = Long - Short
      positionQty: longPosition.qty - shortPosition.qty,

      longPosition: { ...longPosition },
      shortPosition: { ...shortPosition },

      lastPrice,
      realizedPnl: Number(realizedPnl.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      longTotalPnl: Number(longTotal.toFixed(2)),
      shortTotalPnl: Number(shortTotal.toFixed(2)),
      // Lifetime PnL removed
      lifetimePnl: 0,
      lifetimeLongPnl: 0,
      lifetimeShortPnl: 0,
      tradeCount,
      longStats: {
        realizedPnl: Number(longStats.realizedPnl.toFixed(2)),
        tradeCount: longStats.tradeCount
      },
      shortStats: {
        realizedPnl: Number(shortStats.realizedPnl.toFixed(2)),
        tradeCount: shortStats.tradeCount
      },
      liveStats: {
        realizedPnl: Number(liveStats.realizedPnl.toFixed(2)),
        tradeCount: liveStats.tradeCount
      },
      trades,
      metrics,
    };
  }

  return {
    getOpenQty() {
      // Net quantity
      return longPosition.qty - shortPosition.qty;
    },

    // Helper to get specific side qty
    getLongQty() { return longPosition.qty; },
    getShortQty() { return shortPosition.qty; },

    updateMarkPrice(price) {
      lastPrice = price;
      return snapshot();
    },

    getSnapshot() {
      return snapshot();
    },

    openPosition({ side, qty, price, mode = 'PAPER', meta = {} }) {
      // side: 'BUY' (Open Long) or 'SELL' (Open Short)

      const leg = meta.leg;
      const isIndianPE = isIndian && leg === 'PE';

      if (isIndianPE) {
        // Indian PE: long-only, but stored in shortPosition bucket
        const totalCost = shortPosition.avgPrice * shortPosition.qty + price * qty;
        shortPosition.qty += qty;
        shortPosition.avgPrice = shortPosition.qty > 0 ? totalCost / shortPosition.qty : 0;
        shortPosition.mode = mode;

        tradeCount += 1;
        if (mode === 'LIVE') liveStats.tradeCount += 1;

        trades.push({
          ts: Date.now(),
          type: "OPEN",
          side: "BUY",
          qty,
          price,
          strategy: "SHORT",
          mode,
          meta,
        });
        return snapshot();
      }

      if (side === "BUY") {
        // OPEN LONG
        const totalCost = longPosition.avgPrice * longPosition.qty + price * qty;
        longPosition.qty += qty;
        longPosition.avgPrice = longPosition.qty > 0 ? totalCost / longPosition.qty : 0;
        longPosition.mode = mode;

        tradeCount += 1;
        if (mode === 'LIVE') liveStats.tradeCount += 1;

        trades.push({
          ts: Date.now(),
          type: "OPEN",
          side,
          qty,
          price,
          strategy: "LONG",
          mode,
          meta,
        });
      } else if (side === "SELL") {
        // OPEN SHORT
        const totalCost = shortPosition.avgPrice * shortPosition.qty + price * qty;
        shortPosition.qty += qty;
        shortPosition.avgPrice = shortPosition.qty > 0 ? totalCost / shortPosition.qty : 0;
        shortPosition.mode = mode;

        tradeCount += 1;
        if (mode === 'LIVE') liveStats.tradeCount += 1;

        trades.push({
          ts: Date.now(),
          type: "OPEN",
          side,
          qty,
          price,
          strategy: "SHORT",
          mode,
          meta,
        });
      }
      return snapshot();
    },

    closePosition({ side, qty, price, mode = 'PAPER', meta = {} }) {
      // side: 'SELL' (Close Long) or 'BUY' (Close Short)

      const leg = meta.leg;
      const isIndianPE = isIndian && leg === 'PE';

      if (isIndianPE) {
        // Indian PE long: SELL to close
        if (shortPosition.qty <= 0) {
          console.warn("[PnL] Warning: Attempting to close PE LONG but no PE position exists.");
          return snapshot();
        }

        const closeQty = Math.min(qty, shortPosition.qty);
        const pnl = (price - shortPosition.avgPrice) * closeQty;

        realizedPnl += pnl;
        shortStats.realizedPnl += pnl;
        shortStats.tradeCount += 1;

        if (mode === 'LIVE') {
          liveStats.realizedPnl += pnl;
          liveStats.tradeCount += 1;
        }

        shortPosition.qty -= closeQty;
        if (shortPosition.qty <= 0) {
          shortPosition.qty = 0;
          shortPosition.avgPrice = 0;
          shortPosition.mode = null;
        }

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "CLOSE",
          side: "SELL",
          qty: closeQty,
          price,
          pnl,
          strategy: "SHORT",
          mode,
          meta,
        });

        return snapshot();
      }

      if (side === "SELL") {
        // CLOSE LONG
        if (longPosition.qty <= 0) {
          console.warn("[PnL] Warning: Attempting to close LONG but no LONG position exists.");
          return snapshot();
        }

        const closeQty = Math.min(qty, longPosition.qty);
        const pnl = (price - longPosition.avgPrice) * closeQty;

        realizedPnl += pnl;
        longStats.realizedPnl += pnl;
        longStats.tradeCount += 1;

        if (mode === 'LIVE') {
          liveStats.realizedPnl += pnl;
          liveStats.tradeCount += 1;
        }

        longPosition.qty -= closeQty;
        if (longPosition.qty <= 0) {
          longPosition.qty = 0;
          longPosition.avgPrice = 0;
          longPosition.mode = null;
        }

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "CLOSE",
          side,
          qty: closeQty,
          price,
          pnl,
          strategy: "LONG",
          mode,
          meta,
        });

      } else if (side === "BUY") {
        // CLOSE SHORT
        if (shortPosition.qty <= 0) {
          console.warn("[PnL] Warning: Attempting to close SHORT but no SHORT position exists.");
          return snapshot();
        }

        const closeQty = Math.min(qty, shortPosition.qty);
        const pnl = (shortPosition.avgPrice - price) * closeQty;

        realizedPnl += pnl;
        shortStats.realizedPnl += pnl;
        shortStats.tradeCount += 1;

        if (mode === 'LIVE') {
          liveStats.realizedPnl += pnl;
          liveStats.tradeCount += 1;
        }

        shortPosition.qty -= closeQty;
        if (shortPosition.qty <= 0) {
          shortPosition.qty = 0;
          shortPosition.avgPrice = 0;
          shortPosition.mode = null;
        }

        tradeCount += 1;
        trades.push({
          ts: Date.now(),
          type: "CLOSE",
          side,
          qty: closeQty,
          price,
          pnl,
          strategy: "SHORT",
          mode,
          meta,
        });
      }
      return snapshot();
    },

    // --- Persistence ---
    getState() {
      return {
        longPosition,
        shortPosition,
        realizedPnl,
        // Lifetime PnL removed from state
        tradeCount,
        longStats,
        shortStats,
        liveStats,
        trades
      };
    },

    restoreState(state) {
      if (!state) return;

      // Handle legacy state (single position) migration if needed
      if (state.positionQty !== undefined && state.longPosition === undefined) {
        // Legacy state detected. Try to map it.
        if (state.positionSide === 'LONG') {
          longPosition = { qty: state.positionQty, avgPrice: state.avgPrice, mode: null };
          shortPosition = { qty: 0, avgPrice: 0, mode: null };
        } else if (state.positionSide === 'SHORT') {
          shortPosition = { qty: state.positionQty, avgPrice: state.avgPrice, mode: null };
          longPosition = { qty: 0, avgPrice: 0, mode: null };
        } else {
          longPosition = { qty: 0, avgPrice: 0, mode: null };
          shortPosition = { qty: 0, avgPrice: 0, mode: null };
        }
      } else {
        // New state format
        longPosition = state.longPosition || { qty: 0, avgPrice: 0, mode: null };
        shortPosition = state.shortPosition || { qty: 0, avgPrice: 0, mode: null };
        if (longPosition.mode === undefined) longPosition.mode = null;
        if (shortPosition.mode === undefined) shortPosition.mode = null;
      }

      realizedPnl = state.realizedPnl || 0;
      // Lifetime PnL ignored
      tradeCount = state.tradeCount || 0;

      longStats = state.longStats || { realizedPnl: 0, tradeCount: 0 };
      shortStats = state.shortStats || { realizedPnl: 0, tradeCount: 0 };
      liveStats = state.liveStats || { realizedPnl: 0, tradeCount: 0 };

      if (state.trades && Array.isArray(state.trades)) {
        trades.length = 0;
        trades.push(...state.trades);
      }
    },

    reset() {
      // No accumulation to lifetime PnL

      longPosition = { qty: 0, avgPrice: 0, mode: null };
      shortPosition = { qty: 0, avgPrice: 0, mode: null };

      realizedPnl = 0;
      tradeCount = 0;

      // Reset split stats
      longStats = { realizedPnl: 0, tradeCount: 0 };
      shortStats = { realizedPnl: 0, tradeCount: 0 };
      liveStats = { realizedPnl: 0, tradeCount: 0 };

      trades.length = 0;
      lastPrice = null;
    }
  };
}
