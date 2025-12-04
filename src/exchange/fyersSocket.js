import path from 'path';

let DataSocketCtor = null;
let sdkLoadAttempted = false;

async function loadFyersSdk(logger) {
  if (DataSocketCtor || sdkLoadAttempted) {
    return DataSocketCtor;
  }
  sdkLoadAttempted = true;
  try {
    const mod = await import('fyers-api-v3');
    DataSocketCtor =
      mod?.fyersDataSocket ||
      mod?.fyersDataSocketV2 ||
      mod?.default?.fyersDataSocket ||
      mod?.default?.fyersDataSocketV2 ||
      mod?.default ||
      null;
    return DataSocketCtor;
  } catch (error) {
    logger?.error(
      {
        error: error?.message || error,
      },
      'Unable to load fyers-api-v3. Install it with `npm install fyers-api-v3`'
    );
    return null;
  }
}

let socketInstance = null;
let connected = false;
let connecting = false;
let connectPromise = null;
let lastConnectOptions = null;

const desiredSubscriptions = new Set();
const pendingSymbols = new Set();

let subscribeTimer = null;
const SUBSCRIBE_DEBOUNCE_MS = 200;

let tickHandler = null;

function log(logger, level, payload, message) {
  if (!logger || typeof logger[level] !== 'function') {
    console[level === 'error' ? 'error' : 'log'](`[fyersSocket] ${message}`, payload || '');
    return;
  }
  logger[level](payload, message);
}

function scheduleSubscribe(logger) {
  if (!socketInstance || !connected) return;
  if (subscribeTimer) clearTimeout(subscribeTimer);
  subscribeTimer = setTimeout(() => {
    subscribeTimer = null;
    const symbols = Array.from(desiredSubscriptions);
    if (!symbols.length) return;
    const CHUNK = 100;
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const chunk = symbols.slice(i, i + CHUNK);
      try {
        socketInstance.subscribe(chunk);
        log(logger, 'info', { count: chunk.length }, 'Subscribed symbols on FYERS WS');
      } catch (err) {
        log(
          logger,
          'error',
          { error: err?.message || err },
          'Failed to subscribe symbols on FYERS WS'
        );
      }
    }
  }, SUBSCRIBE_DEBOUNCE_MS);
}

function handleIncomingMessage(message, logger) {
  if (!tickHandler) return;
  let payload = message;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      log(logger, 'warn', { preview: payload.slice(0, 200) }, 'Non-JSON FYERS message');
      return;
    }
  }

  const rows = Array.isArray(payload?.d)
    ? payload.d
    : Array.isArray(payload)
      ? payload
      : [payload];

  for (const row of rows) {
    const v = row?.v ?? row;
    const symbol =
      v?.symbol ?? v?.sym ?? v?.code ?? v?.symbolName ?? v?.id ?? v?.instrument;

    const ltp = [v?.ltp, v?.lp, v?.price, v?.P, v?.lastPrice, v?.closePrice]
      .map((value) => Number(value))
      .find((n) => Number.isFinite(n));

    if (symbol && Number.isFinite(ltp)) {
      tickHandler({
        symbol: String(symbol),
        ltp: Number(ltp),
        ts: Date.now(),
        raw: v,
      });
    }
  }
}

export async function connectFyersSocket({ token, logPath, logger, onTick }) {
  tickHandler = onTick;
  lastConnectOptions = { token, logPath, logger };
  if (connected || connecting) {
    return connectPromise;
  }

  connectPromise = (async () => {
    connecting = true;
    const DataSocket = await loadFyersSdk(logger);
    if (!DataSocket) {
      connecting = false;
      throw new Error('fyers-api-v3 module not available');
    }

    // Resolve token if it's a function (dynamic provider)
    const actualToken = typeof token === 'function' ? await token() : token;

    if (!actualToken) {
      connecting = false;
      throw new Error('FYERS socket token missing');
    }
    const resolvedLogPath = logPath
      ? path.resolve(logPath)
      : path.resolve('data', 'fyers-logs');

    socketInstance = DataSocket.getInstance(actualToken, resolvedLogPath);

    socketInstance.on('connect', () => {
      connected = true;
      connecting = false;
      log(logger, 'info', null, 'Connected to FYERS websocket');
      if (pendingSymbols.size) {
        scheduleSubscribe(logger);
        pendingSymbols.clear();
      }
    });

    socketInstance.on('message', (message) => handleIncomingMessage(message, logger));

    socketInstance.on('error', (error) => {
      log(logger, 'error', { error: error?.message || error }, 'FYERS websocket error');
    });

    socketInstance.on('close', () => {
      if (connected) {
        log(logger, 'warn', null, 'FYERS websocket closed, attempting reconnect');
      }
      connected = false;
      connecting = false;

      // Manual reconnection with fresh token
      setTimeout(() => {
        log(logger, 'info', null, 'Initiating manual reconnection...');
        connectFyersSocket(lastConnectOptions).catch(() => { });
      }, 5000);
    });

    socketInstance.connect();
  })();

  return connectPromise.catch((err) => {
    connected = false;
    connecting = false;
    connectPromise = null;
    log(logger, 'error', { error: err?.message || err }, 'Failed to connect FYERS websocket');
    throw err;
  });
}

export function subscribeSymbols(symbols = []) {
  for (const symbol of symbols) {
    if (!symbol) continue;
    desiredSubscriptions.add(symbol);
    if (!connected) {
      pendingSymbols.add(symbol);
    }
  }

  if (!socketInstance || !connected) {
    if (!connecting && lastConnectOptions) {
      connectFyersSocket(lastConnectOptions).catch(() => { });
    }
    return;
  }

  scheduleSubscribe(lastConnectOptions?.logger);
}
