// src/signals/parseTradingViewMessage.js

// Examples:
// "Accepted Entry + priorRisePct= 0.00 | stopPx=100 | sym=BTCUSDT"
// "Accepted Exit + priorRisePct= 0.00 | stopPx=100 | sym=BTCUSDT"
export function parseTradingViewMessage(message) {
  if (typeof message !== 'string') return { side: null };

  const trimmed = message.trim();
  const isEntry = /Accepted\s+Entry/i.test(trimmed);
  const isExit = /Accepted\s+Exit/i.test(trimmed);

  const side =
    isEntry ? 'BUY' :
    isExit ? 'SELL' :
    null;

  return { side };
}
