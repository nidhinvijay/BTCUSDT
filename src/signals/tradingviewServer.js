import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import { parseTradingViewMessage } from './parseTradingViewMessage.js';
import { broadcastToRelays } from './relayService.js';
import { config } from '../config/env.js';

let wssInstance = null;

export function normalizeInstrumentSymbol(baseSymbol, rawSymbol) {
  if (!rawSymbol) return null;
  const allowed = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
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

export function mapIndianOptionSymbol(symbol) {
  const raw = symbol.startsWith('NSE:') || symbol.startsWith('BSE:') ? symbol.slice(4) : symbol;

  // Pattern: ROOT + YY + MM + DD + (C/P) + STRIKE
  const match = /^(NIFTY|BANKNIFTY|SENSEX|BSX)(\d{2})(\d{2})(\d{2})([CP])(\d+)$/.exec(raw);
  if (!match) {
    // Fallback: Try to determine if it's a valid Fyers symbol
    const fyersSymbol = symbol.includes(':') ? symbol : `NSE:${symbol}`;
    const suffixMatch = /(CE|PE|C|P)$/i.exec(raw);
    const optionType = suffixMatch ? (suffixMatch[1].startsWith('P') ? 'PUT' : 'CALL') : null;
    return { fyersSymbol, optionType };
  }

  const [, root, yy, mm, dd, cp, strikeRaw] = match;

  // BSX (TradingView) maps to SENSEX (Fyers)
  const rootSymbol = (root === 'BSX') ? 'SENSEX' : root;

  const cepe = cp === 'C' ? 'CE' : 'PE';
  const optionType = cepe === 'CE' ? 'CALL' : 'PUT';

  const MONTH_3L = {
    '01': 'JAN', '02': 'FEB', '03': 'MAR', '04': 'APR',
    '05': 'MAY', '06': 'JUN', '07': 'JUL', '08': 'AUG',
    '09': 'SEP', '10': 'OCT', '11': 'NOV', '12': 'DEC',
  };

  const MONTH_LETTER = {
    '01': '1', '02': '2', '03': '3', '04': '4', '05': '5', '06': '6',
    '07': '7', '08': '8', '09': '9', '10': 'O', '11': 'N', '12': 'D',
  };

  // BANKNIFTY and NIFTY both support weekly options.
  // SENSEX final week (last Thursday, day >= 23) uses monthly format.
  let expiryCode;
  
  // Helper to check if a date is the last Wednesday of the month (BankNifty Monthly Expiry)
  const isMonthlyExpiry = (year, month, day) => {
    // Month is 1-indexed in our input (01-12)
    const d = new Date(2000 + parseInt(year), parseInt(month) - 1, parseInt(day));
    // Check if it's a Wednesday (Day 3)
    if (d.getDay() !== 3) return false;
    
    // Check if adding 7 days moves to next month
    const nextWeek = new Date(d);
    nextWeek.setDate(d.getDate() + 7);
    return nextWeek.getMonth() !== d.getMonth();
  };

  // Special case for SENSEX monthly expiry
  if (rootSymbol === 'SENSEX' && parseInt(dd) >= 23) {
    const month3L = MONTH_3L[mm];
    if (!month3L) return null;
    expiryCode = `${yy}${month3L}`; // Monthly format for SENSEX final week
  } else if (rootSymbol === 'BANKNIFTY' && isMonthlyExpiry(yy, mm, dd)) {
    // BANKNIFTY Monthly Expiry (Last Wednesday) uses MMM format
    const month3L = MONTH_3L[mm];
    if (!month3L) return null;
    expiryCode = `${yy}${month3L}`;
  } else {
    // Default to weekly format (YY + MonthLetter + DD) for NIFTY, BANKNIFTY, and SENSEX weekly
    const monLetter = MONTH_LETTER[mm];
    if (!monLetter) return null;
    expiryCode = `${yy}${monLetter}${dd}`; 
  }

  // SENSEX options are on BSE, not NSE
  const exchange = rootSymbol === 'SENSEX' ? 'BSE' : 'NSE';

  // Use exact strike from TradingView (no adjustments needed)
  const strike = strikeRaw;

  return { fyersSymbol: `${exchange}:${rootSymbol}${expiryCode}${strike}${cepe}`, optionType };
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

      // Strip BSE: prefix for SENSEX symbols (Fyers uses just SENSEX, not BSE:SENSEX)
      let cleanedSymbol = extracted;
      if (extracted.startsWith('BSE:')) {
        cleanedSymbol = extracted.replace(/^BSE:/, '');
        signalInstrument = cleanedSymbol; // Use without BSE: prefix
      }

      const typeMatch = /(CE|PE|C|P)$/i.exec(cleanedSymbol);
      if (typeMatch) {
        const raw = typeMatch[1].toUpperCase();
        optionType = raw === 'PE' || raw === 'P' ? 'PUT' : 'CALL';
      } else {
        optionType = null;
      }

      if (activeBots.has(cleanedSymbol)) {
        symbol = cleanedSymbol;
      } else {
        // Handle common ticker aliases
        if (cleanedSymbol.startsWith('BSX')) {
          // BSX is SENSEX ticker - replace with SENSEX for routing
          const sensexSymbol = cleanedSymbol.replace(/^BSX/, 'SENSEX');
          if (activeBots.has('SENSEX')) {
            symbol = 'SENSEX';
            signalInstrument = sensexSymbol; // Use corrected symbol for Fyers
          }
        } else if (cleanedSymbol.startsWith('NIFY')) {
          // Common typo NIFY → NIFTY
          const niftySymbol = cleanedSymbol.replace(/^NIFY/, 'NIFTY');
          if (activeBots.has('NIFTY')) {
            symbol = 'NIFTY';
            signalInstrument = niftySymbol;
          }
        } else {
          // Try prefix matching for option symbols
          for (const key of activeBots.keys()) {
            if (cleanedSymbol.startsWith(key)) {
              symbol = key;
              break;
            }
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
      // For index options, don't override the signal
      // Just track the option type for routing later
      logger.info({ optionType }, "Detected option type");
    }

    if (!side) {
      logger.warn({ message }, "Unknown TradingView message format");
      return res.status(400).json({ error: "Unknown message format" });
    }

    logger.info({ side, symbol, message, optionType }, "Received TradingView signal");

    // Determine if this is an Indian index
    const isIndianIndex = ['NIFTY', 'BANKNIFTY', 'SENSEX'].some(idx => symbol.includes(idx));

    // Emit signals to Paper bot
    if (isIndianIndex && optionType) {
      const paperFsm = bot.paper?.fsm;
      const controller = bot.controller;
      const longPos = paperFsm ? paperFsm.getLongPosition() : null;
      const shortPos = paperFsm ? paperFsm.getShortPosition() : null;

      if (optionType === 'CALL') {
        let closed = false;
        if (
          side === 'SELL' &&
          longPos &&
          longPos.qty > 0 &&
          typeof paperFsm.forceCloseLong === 'function'
        ) {
          closed = paperFsm.forceCloseLong("TV_SELL_EXIT");
          if (closed) {
            // Also close LIVE position
            const liveFsm = bot.live?.fsm;
            if (liveFsm && typeof liveFsm.forceCloseLong === 'function') {
              liveFsm.forceCloseLong("TV_SELL_EXIT");
            }
            logger.info({ symbol }, "Closed CE position on SELL signal");
          }
        }
        // Always emit new signal to Paper, even if we just closed a position (Close + Re-enter)
        if (closed) {
          if (typeof paperFsm.logSignal === 'function') {
            // Log the Exit signal first, explicitly for BUY FSM (CE)
            paperFsm.logSignal(side, 'TradingView', 'BUY');
          }
          // Also log to Live FSM if it exists
          const liveFsm = bot.live?.fsm;
          if (liveFsm && typeof liveFsm.logSignal === 'function') {
             liveFsm.logSignal(side, 'TradingView', 'BUY');
          }
        }

        // For CE, a re-entry is a BUY signal (even if triggered by a SELL exit)
        bot.paper.signalBus.emitBuy({
          source: closed ? 'Close + Re-entry' : 'TradingView',
          action: closed ? 'BUY' : side,
          optionType
        });
        logger.info({ symbol, side, optionType, closed }, "CE signal routed to BUY FSM");
      } else if (optionType === 'PUT') {
        let closed = false;
        let actionForFsm = side;

        if (
          side === 'SELL' &&
          shortPos &&
          shortPos.qty > 0 &&
          typeof paperFsm.forceCloseShort === 'function'
        ) {
          closed = paperFsm.forceCloseShort("TV_SELL_EXIT");
          if (closed) {
            // Also close LIVE position
            const liveFsm = bot.live?.fsm;
            if (liveFsm && typeof liveFsm.forceCloseShort === 'function') {
              liveFsm.forceCloseShort("TV_SELL_EXIT");
            }
            logger.info({ symbol }, "Closed PE position on SELL signal");
          }
        } else if (side === 'SELL') {
          // No PE position open: treat this SELL signal as a BUY entry for PE
          actionForFsm = 'BUY';
          logger.info({ symbol }, "PE SELL with no open position - treating as BUY entry for PE");
        }

        // Always emit new signal to Paper, even if we just closed a position (Close + Re-entry)
        if (closed) {
          if (typeof paperFsm.logSignal === 'function') {
            // Log the Exit signal first, explicitly for SELL FSM (PE)
            // Log as 'BUY' so that the dashboard flips it to 'SELL' (Exit)
            paperFsm.logSignal('BUY', 'TradingView', 'SELL');
          }
          // Also log to Live FSM if it exists
          const liveFsm = bot.live?.fsm;
          if (liveFsm && typeof liveFsm.logSignal === 'function') {
             liveFsm.logSignal('BUY', 'TradingView', 'SELL');
          }
        }

        // For PE, a re-entry is a SELL signal
        bot.paper.signalBus.emitSell({
          source: closed ? 'Close + Re-entry' : 'TradingView',
          action: (closed || actionForFsm === 'BUY') ? 'SELL' : actionForFsm, 
          optionType
        });
        logger.info({ symbol, side, optionType, closed, actionForFsm }, "PE signal routed to SELL FSM");
      }
    } else {
      // For BTCUSDT or base index: Keep original logic
      if (side === "BUY") bot.paper.signalBus.emitBuy({ source: 'TradingView' });
      if (side === "SELL") bot.paper.signalBus.emitSell({ source: 'TradingView' });
    }

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
      const closedPaper = bot.paper.fsm.manualCloseAll();
      const closedLive = bot.live.fsm.manualCloseAll();
      const closed = closedPaper || closedLive;
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
