// src/state/sessionState.js
export class SessionManager {
  constructor(dailyLossLimit = -1000) {
    this.state = {
      mode: "PAPER",
      paperCumulativePnL: 0,
      liveCumulativePnL: 0,
      totalLiveRealisedPnL: 0,
      dailyRealisedPnL: 0,
      dailyLossLimit,
      dailyStopActive: false,
      trades: [],
    };
  }

  getState() {
    return { ...this.state };
  }

  updatePaperPnL(pnl) {
    if (this.state.mode !== "PAPER") return;

    this.state.paperCumulativePnL += pnl;
    this.checkGate();
  }

  updateLivePnL(pnl) {
    if (this.state.mode !== "LIVE") return;

    this.state.liveCumulativePnL += pnl;
    this.state.totalLiveRealisedPnL += pnl;
    this.state.dailyRealisedPnL += pnl;

    this.checkRiskFlags();
    this.checkDailyStop();
  }

  checkGate() {
    // One-way gate: PAPER -> LIVE if paperCumulativePnL > 0
    if (this.state.mode === "PAPER" && this.state.paperCumulativePnL > 0) {
      this.state.mode = "LIVE";
      console.log("🚀 SWITCHING TO LIVE MODE! Paper P&L > 0");
      // Reset live P&L tracking on entry if needed, or keep as 0
      this.state.liveCumulativePnL = 0; 
    }
  }

  checkRiskFlags() {
    // Spec Rule: "If in live we go below 0... leave to paper for this cycle."
    if (this.state.mode === "LIVE" && this.state.liveCumulativePnL < 0) {
      console.warn("⚠️ Live PnL is negative. Switching back to PAPER for the rest of the cycle.");
      this.state.mode = "PAPER";
      this.state.dailyStopActive = true; // Treat as daily stop to prevent re-entry
    }
  }

  checkDailyStop() {
    if (this.state.dailyRealisedPnL <= this.state.dailyLossLimit) {
      this.state.dailyStopActive = true;
      console.warn("🛑 DAILY STOP HIT! No new live trades.");
    }
  }

  resetDailyStats() {
    this.state.dailyRealisedPnL = 0;
    this.state.dailyStopActive = false;
  }

  addTrade(trade) {
    this.state.trades.unshift(trade); // Add to top
    // Keep only last 50 trades
    if (this.state.trades.length > 50) {
      this.state.trades.pop();
    }
  }
}
