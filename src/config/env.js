// src/config/env.js
import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // List of active symbols
  symbols: ['BTCUSDT', 'NIFTY', 'BANKNIFTY', 'SENSEX'],
  
  // Default symbol to show on dashboard load
  defaultSymbol: 'BTCUSDT',

  // Per-symbol configuration
  symbolConfig: {
    BTCUSDT: {
      qty: 1,
      stopLossOffset: 0.5,
      entryOffset: 0.5
    },
    NIFTY: {
      qty: 50, // Standard Nifty Lot
      stopLossOffset: 5,
      entryOffset: 5
    },
    BANKNIFTY: {
      qty: 15, // Standard BankNifty Lot
      stopLossOffset: 10,
      entryOffset: 10
    },
    SENSEX: {
      qty: 10, // Standard Sensex Lot
      stopLossOffset: 20,
      entryOffset: 20
    }
  },

  // Fyers API Configuration (optional - for Indian indices)
  fyers: {
    appId: process.env.FYERS_APP_ID,
    secretKey: process.env.FYERS_SECRET_KEY,
    redirectUri: process.env.FYERS_REDIRECT_URI,
    pin: process.env.FYERS_PIN,
    enabled: process.env.FYERS_APP_ID && process.env.FYERS_APP_ID !== 'YOUR_FYERS_APP_ID'
  },

  // Exchange mapping per symbol
  exchangeMapping: {
    BTCUSDT: 'binance',
    NIFTY: 'fyers',
    BANKNIFTY: 'fyers',
    SENSEX: 'fyers'
  },

  liveGate: (() => {
    const rawThreshold = parseFloat(process.env.LIVE_GATE_THRESHOLD ?? '0');
    return {
      enabled:
        process.env.LIVE_GATE_ENABLED !== undefined
          ? process.env.LIVE_GATE_ENABLED !== 'false'
          : true,
      threshold: Number.isFinite(rawThreshold) ? rawThreshold : 0,
    };
  })(),

  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info'
};
