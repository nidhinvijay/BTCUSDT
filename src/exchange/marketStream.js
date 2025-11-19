import { connectTradeStream } from './binanceClient.js';

export function startMarketStream({ symbol, onTick, logger }) {
  const ws = connectTradeStream({
    symbol,
    onMessage: (trade) => {
      const ltp = parseFloat(trade.p); // last price
      const ts = trade.T;              // trade time in ms
      onTick && onTick({ ltp, ts });
    },
    onError: (err) => logger.error({ err }, 'Market stream error'),
    onClose: () => logger.warn('Market stream closed')
  });

  return ws;
}
