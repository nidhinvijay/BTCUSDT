// src/exchange/fyersStream.js
// Fyers WebSocket wrapper for market data streaming
import { isMarketOpen, getMarketStatus } from '../utils/marketHours.js';

export function startFyersStream({ symbol, accessToken, onTick, logger }) {
  // Note: Fyers WebSocket requires their Python/Node SDK
  // For now, we'll use polling as a fallback
  
  let intervalId = null;
  
  const pollPrice = async () => {
    try {
      // Check if market is open
      if (!isMarketOpen(symbol)) {
        const status = getMarketStatus(symbol);
        logger.info({ symbol, status: status.message }, 'Skipping Fyers poll - market closed');
        return;
      }
      
      // Import dynamically to avoid circular deps
      const { FyersMarketData } = await import('../brokers/fyersMarketData.js');
      const marketData = new FyersMarketData({ accessToken, logger });
      
      // Map symbol to Fyers format (v3)
      let fyersSymbol;
      if (symbol === 'NIFTY') {
        fyersSymbol = 'NSE:NIFTY50';  // Updated for v3
      } else if (symbol === 'BANKNIFTY') {
        fyersSymbol = 'NSE:BANKNIFTY';  // Updated for v3
      } else if (symbol === 'SENSEX') {
        fyersSymbol = 'BSE:SENSEX';  // Updated for v3
      } else {
        fyersSymbol = symbol;
      }
      
      const quotes = await marketData.getQuotes([fyersSymbol]);
      
      if (quotes && quotes[fyersSymbol]) {
        const quote = quotes[fyersSymbol].v;
        onTick({
          symbol,
          ltp: quote.lp || quote.close_price,
          volume: quote.volume,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      logger.error({ error: error.message, symbol }, 'Fyers polling error');
    }
  };
  
  // Poll every 1 second
  intervalId = setInterval(pollPrice, 1000);
  
  // Initial fetch
  pollPrice();
  
  logger.info({ symbol }, 'Started Fyers price polling');
  
  return {
    close: () => {
      if (intervalId) {
        clearInterval(intervalId);
        logger.info({ symbol }, 'Stopped Fyers price polling');
      }
    }
  };
}
