import fs from 'fs';
import path from 'path';
import { connectFyersSocket, subscribeSymbols } from './fyersSocket.js';

const listeners = new Map();
const lastTicks = new Map();

let connectionPromise = null;

function handleTick(tick) {
  lastTicks.set(tick.symbol, tick);
  const symbolListeners = listeners.get(tick.symbol);
  if (!symbolListeners) return;
  symbolListeners.forEach((listener) => {
    try {
      listener(tick);
    } catch (err) {
      console.error(`[FyersDataHub] Listener error for ${tick.symbol}`, err);
    }
  });
}

export async function ensureFyersHub({ appId, accessToken, logger }) {
  if (!accessToken) {
    throw new Error('FYERS access token missing');
  }

  // Create a token provider that handles both string and function
  const tokenProvider = async () => {
    const rawToken = typeof accessToken === 'function' ? await accessToken() : accessToken;
    if (!rawToken) return null;
    return rawToken.includes(':') ? rawToken : `${appId}:${rawToken}`;
  };

  const logBase = process.env.FYERS_WS_LOG_PATH
    ? path.resolve(process.env.FYERS_WS_LOG_PATH)
    : path.resolve('data', 'fyers-logs');

  if (!connectionPromise) {
    fs.mkdirSync(logBase, { recursive: true });
    connectionPromise = connectFyersSocket({
      token: tokenProvider,
      logPath: logBase,
      logger,
      onTick: handleTick,
    });
  }

  return connectionPromise;
}

export function subscribeToSymbol(symbol, listener) {
  if (!symbol) return () => { };
  if (!listeners.has(symbol)) {
    listeners.set(symbol, new Set());
  }
  listeners.get(symbol).add(listener);
  subscribeSymbols([symbol]);
  const cached = lastTicks.get(symbol);
  if (cached) {
    listener(cached);
  }
  return () => {
    const symbolListeners = listeners.get(symbol);
    if (!symbolListeners) return;
    symbolListeners.delete(listener);
    if (symbolListeners.size === 0) {
      listeners.delete(symbol);
    }
  };
}

export function getLastTick(symbol) {
  return lastTicks.get(symbol) || null;
}
