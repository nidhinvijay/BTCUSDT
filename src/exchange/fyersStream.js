// src/exchange/fyersStream.js
import { ensureFyersHub, subscribeToSymbol } from './fyersDataHub.js';

const FYERS_SYMBOL_MAP = {
  NIFTY: 'NSE:NIFTY50-INDEX',
  BANKNIFTY: 'NSE:NIFTYBANK-INDEX',
  SENSEX: 'BSE:SENSEX-INDEX',
  FINNIFTY: 'NSE:FINNIFTY-INDEX',
};

export async function startFyersStream({
  symbol,
  accessToken,
  appId,
  onTick,
  logger,
}) {
  await ensureFyersHub({ appId, accessToken, logger });

  const fyersSymbol = FYERS_SYMBOL_MAP[symbol] || symbol;

  const unsubscribe = subscribeToSymbol(fyersSymbol, (tick) => {
    onTick({
      symbol,
      ltp: tick.ltp,
      ts: tick.ts,
    });
  });

  logger.info({ symbol, fyersSymbol }, 'Subscribed to FYERS websocket stream');

  return {
    close: () => {
      unsubscribe();
      logger.info({ symbol, fyersSymbol }, 'Unsubscribed from FYERS websocket stream');
    },
  };
}
