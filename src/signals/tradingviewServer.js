import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { parseTradingViewMessage } from './parseTradingViewMessage.js';
import { broadcastToRelays } from './relayService.js';
import { config } from '../config/env.js';

let wssInstance = null;

function normalizeInstrumentSymbol(baseSymbol, rawSymbol) {
  if (!rawSymbol) return null;
  const allowed = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'];
  const cleaned = rawSymbol.toUpperCase();
  if (cleaned === baseSymbol) return null;

  if (!allowed.includes(baseSymbol)) {
    const fyersSymbol = cleaned.includes(':') ? cleaned : `NSE:${cleaned}`;
    const display = cleaned.includes(':') ? cleaned.split(':').pop() : cleaned;
    return { display, fyersSymbol, optionType: null };
  }

  const mapped = mapIndianOptionSymbol(cleaned);
  if (mapped) {
    const display = cleaned.includes(':') ? cleaned.split(':').pop() : cleaned;
    return { display, fyersSymbol: mapped.fyersSymbol, optionType: mapped.optionType };
  }

  const fallback = cleaned.includes(':') ? cleaned : `NSE:${cleaned}`;
  const fallbackDisplay = cleaned.includes(':') ? cleaned.split(':').pop() : cleaned;
  return { display: fallbackDisplay, fyersSymbol: fallback, optionType: null };
}

function mapIndianOptionSymbol(symbol) {
  const raw = symbol.startsWith('NSE:') ? symbol.slice(4) : symbol;
  const match = /^(NIFTY|FINNIFTY|BANKNIFTY|SENSEX)(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(raw);
  if (!match) {
    const fyersSymbol = symbol.includes(':') ? symbol : `NSE:${symbol}`;
    const suffixMatch = /(CE|PE|C|P)$/i.exec(raw);
    const optionType = suffixMatch ? (suffixMatch[1].startsWith('P') ? 'PUT' : 'CALL') : null;
    return { fyersSymbol, optionType };
  }

  const [, root, yy, mm, dd, cp, strike] = match;
  const cepe = cp === 'C' ? 'CE' : 'PE';
  const optionType = cepe === 'CE' ? 'CALL' : 'PUT';

  const MONTH_3L = {
    '01': 'JAN',
    '02': 'FEB',
    '03': 'MAR',
    '04': 'APR',
    '05': 'MAY',
    '06': 'JUN',
    '07': 'JUL',
    '08': 'AUG',
    '09': 'SEP',
    '10': 'OCT',
    '11': 'NOV',
    '12': 'DEC',
  };

  const MONTH_LETTER = {
    '01': 'A',
    '02': 'F',
    '03': 'M',
    '04': 'A',
    '05': 'M',
    '06': 'J',
    '07': 'J',
    '08': 'A',
    '09': 'S',
    '10': 'O',
    '11': 'N',
    '12': 'D',
  };

  // All Indian options use month letter + day format (e.g., 25D02 for 2025 Dec 02)
  const monLetter = MONTH_LETTER[mm];
  if (!monLetter) return null;
  const expiryCode = `${yy}${monLetter}${dd}`;
  return { fyersSymbol: `NSE:${root}${expiryCode}${strike}${cepe}`, optionType };
}

export function setWss(wss) {
  wssInstance = wss;
}

export function startTradingViewServer({ activeBots, logger }) {
  const app = express();
  app.use(bodyParser.text({ type: '*/*' }));
  app.use(express.static('public')); // Serve static files if any

  // ------------------------------------------------------------
  //  Dashboard HTML is now served via express.static('public')
  // ------------------------------------------------------------

  // ------------------------------------------------------------
  //  Webhook Endpoint
  // ------------------------------------------------------------
  app.post("/webhook", (req, res) => {
    const message = req.body;

    // Parse message
    const { side: parsedSide } = parseTradingViewMessage(message);
    let side = parsedSide;

    let symbol = config.defaultSymbol;
    let signalInstrument = null;
    let optionType = null;
    const match = message.match(/sym=([A-Z0-9]+)/i);
    if (match && match[1]) {
      const extracted = match[1].toUpperCase();
      signalInstrument = extracted;
      const typeMatch = /(CE|PE|C|P)$/i.exec(extracted);
      if (typeMatch) {
        const raw = typeMatch[1].toUpperCase();
        optionType = raw === 'PE' || raw === 'P' ? 'PUT' : 'CALL';
      } else {
        optionType = null;
      }

      if (activeBots.has(extracted)) {
        symbol = extracted;
      } else {
        for (const key of activeBots.keys()) {
          if (extracted.startsWith(key)) {
            symbol = key;
            break;
          }
        }
      }
    }

    const bot = activeBots.get(symbol);

    if (bot && typeof bot.setInstrument === 'function') {
      const instrumentInfo = normalizeInstrumentSymbol(symbol, signalInstrument);
      bot.setInstrument(instrumentInfo);
      if (instrumentInfo?.optionType) {
        optionType = instrumentInfo.optionType;
      }
    }

    if (!bot) {
      logger.error({ symbol }, "Received signal for unknown symbol");
      return res.status(400).json({ error: "Unknown symbol" });
    }

    if (optionType) {
      // For index options:
      // - CALL (C/CE) drives CE (long) strategy  -> BUY
      // - PUT  (P/PE) drives PE (short) strategy -> SELL
      side = optionType === 'PUT' ? 'SELL' : 'BUY';
    }

    if (!side) {
      logger.warn({ message }, "Unknown TradingView message format");
      return res.status(400).json({ error: "Unknown message format" });
    }

    logger.info({ side, symbol, message }, "Received TradingView signal");

    // Emit BUY/SELL internally
    if (side === "BUY") bot.signalBus.emitBuy();
    if (side === "SELL") bot.signalBus.emitSell();

    // Broadcast to Dashboard Clients
    if (wssInstance) {
      const signalMsg = JSON.stringify({
        type: 'SIGNAL',
        data: { symbol, side, ts: Date.now() }
      });
      wssInstance.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(signalMsg);
        }
      });
    }

    // Respond immediately
    res.json({ status: "ok", symbol });

    // Relay
    broadcastToRelays({
      message: message,
      type: "tradingview-signal",
      side,
      symbol,
      ts: Date.now(),
    }, logger);
  });

  // ------------------------------------------------------------
  //  API Endpoints
  // ------------------------------------------------------------
  app.post("/api/close", (req, res) => {
    const symbol = req.query.symbol || config.defaultSymbol;
    const bot = activeBots.get(symbol);
    if (bot) {
      const closed = bot.fsm.manualCloseAll();
      res.json({ success: true, closed, symbol });
    } else {
      res.status(404).json({ error: "Bot not found" });
    }
  });

  app.post("/api/reset", (req, res) => {
    const symbol = req.query.symbol || config.defaultSymbol;
    // Trigger the scheduler's reset logic manually? 
    // Or just replicate it here.
    // Let's replicate the archive logic for single symbol.

    const filePath = path.resolve('data', `${symbol}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const archiveDir = path.resolve('data', 'archive');
        if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = path.join(archiveDir, `${symbol}_${timestamp}.json`);
        fs.copyFileSync(filePath, archivePath);
        fs.unlinkSync(filePath);
      } catch (e) {
        logger.error(e, "Reset failed");
      }
    }

    res.json({ success: true, message: "Resetting...", symbol });
    setTimeout(() => process.exit(0), 500);
  });

  // ------------------------------------------------------------
  //  Fyers OAuth Endpoints (Browser-based)
  // ------------------------------------------------------------
  app.get("/fyers/auth", (req, res) => {
    // Check if Fyers is configured
    if (!config.fyers.enabled) {
      return res.send(`
        <html>
          <body style="font-family: Arial; padding: 40px; text-align: center;">
            <h2>❌ Fyers Not Configured</h2>
            <p>Please add FYERS_APP_ID and FYERS_SECRET_KEY to your .env file</p>
            <a href="/">Return to Dashboard</a>
          </body>
        </html>
      `);
    }

    // Import auth module
    import('../brokers/fyersAuth.js').then(({ FyersAuth }) => {
      const fyersAuth = new FyersAuth({
        appId: config.fyers.appId,
        secretKey: config.fyers.secretKey,
        redirectUri: `${req.protocol}://${req.get('host')}/fyers/callback`,
        logger
      });

      const { authUrl } = fyersAuth.getAuthCodeUrl();

      // Redirect to Fyers login
      res.redirect(authUrl);
    });
  });

  app.get("/fyers/callback", async (req, res) => {
    const { auth_code, state } = req.query;

    if (!auth_code) {
      return res.send(`
        <html>
          <body style="font-family: Arial; padding: 40px; text-align: center;">
            <h2>❌ Authentication Failed</h2>
            <p>No authorization code received</p>
            <a href="/fyers/auth">Try Again</a>
          </body>
        </html>
      `);
    }

    try {
      // Import auth module
      const { FyersAuth } = await import('../brokers/fyersAuth.js');
      const fyersAuth = new FyersAuth({
        appId: config.fyers.appId,
        secretKey: config.fyers.secretKey,
        redirectUri: `${req.protocol}://${req.get('host')}/fyers/callback`,
        logger
      });

      // Get access token
      const accessToken = await fyersAuth.getAccessToken(auth_code);

      // Success! Redirect to dashboard
      res.send(`
        <html>
          <head>
            <meta http-equiv="refresh" content="3;url=/" />
            <style>
              body {
                font-family: Arial;
                padding: 40px;
                text-align: center;
                background: #0d1117;
                color: #c9d1d9;
              }
              .success {
                background: #238636;
                color: white;
                padding: 20px;
                border-radius: 8px;
                display: inline-block;
                margin: 20px;
              }
            </style>
          </head>
          <body>
            <div class="success">
              <h2>✅ Fyers Authentication Successful!</h2>
              <p>Token saved. Redirecting to dashboard...</p>
              <p><small>Access Token: ${accessToken.substring(0, 20)}...</small></p>
            </div>
            <p>If not redirected, <a href="/" style="color: #58a6ff;">click here</a></p>
          </body>
        </html>
      `);

      logger.info('Fyers authentication successful via dashboard');

      // Restart needed to load new token - we could also hot-reload here
      setTimeout(() => {
        logger.info('Restarting to load new Fyers token...');
        process.exit(0); // PM2/systemd will restart
      }, 5000);

    } catch (error) {
      logger.error({ error }, 'Fyers callback error');
      res.send(`
        <html>
          <body style="font-family: Arial; padding: 40px; text-align: center;">
            <h2>❌ Authentication Error</h2>
            <p>${error.message}</p>
            <a href="/fyers/auth">Try Again</a>
          </body>
        </html>
      `);
    }
  });

  app.get("/fyers/status", (req, res) => {
    // Check current Fyers auth status
    import('../brokers/fyersAuth.js').then(({ FyersAuth }) => {
      if (!config.fyers.enabled) {
        return res.json({
          authenticated: false,
          configured: false,
          message: 'Fyers not configured in .env'
        });
      }

      const fyersAuth = new FyersAuth({
        appId: config.fyers.appId,
        secretKey: config.fyers.secretKey,
        redirectUri: config.fyers.redirectUri,
        logger
      });

      const isAuth = fyersAuth.isAuthenticated();
      res.json({
        authenticated: isAuth,
        configured: true,
        message: isAuth ? 'Fyers authenticated' : 'Authentication required'
      });
    });
  });

  return app;
}
