// src/signals/tradingviewServer.js
import express from "express";
import { config } from "../config/env.js";
import { parseTradingViewMessage } from "./parseTradingViewMessage.js";

const relays = new Set();

// If your Node version does NOT have global fetch:
// import fetch from 'node-fetch';

async function broadcastToRelays(event, logger) {
  const RELAY_TIMEOUT_MS = 5000; // 5 second timeout

  const promises = Array.from(relays).map(async (url) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Get error response body to understand what went wrong
        const errorText = await response.text().catch(() => "No error body");
        logger.warn(
          { url, status: response.status, errorBody: errorText },
          "Relay responded with error status"
        );
      } else {
        logger.debug({ url }, "Relay broadcast successful");
      }
    } catch (err) {
      if (err.name === "AbortError") {
        logger.error({ url, timeout: RELAY_TIMEOUT_MS }, "Relay POST timeout");
      } else {
        logger.error({ err, url }, "Relay POST failed");
      }
    }
  });

  // Fire and forget - don't wait for all relays
  Promise.allSettled(promises);
}

export function startTradingViewServer({ signalBus, fsm, pnlContext, logger }) {
  const app = express();

  // Accept JSON and RAW TEXT
  app.use(express.json({ limit: "2mb" }));
  app.use(express.text({ type: "*/*", limit: "2mb" }));

  // -----------------------------
  //  Webhook (JSON OR raw text)
  // -----------------------------
  app.post("/webhook", async (req, res) => {
    let raw = req.body;
    let body = raw;
    let message = null;

    // STEP 1 — If raw is a string, attempt JSON parse
    if (typeof raw === "string") {
      const trimmed = raw.trim();

      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          body = JSON.parse(trimmed);
        } catch {
          body = trimmed; // fallback to raw text
        }
      } else {
        body = trimmed; // pure text message
      }
    }

    // STEP 2 — Extract message
    if (typeof body === "string") {
      message = body.trim();
    } else if (body && typeof body === "object") {
      message = body.message ?? body.text ?? body.signal ?? null;
    }

    // STEP 3 — Must be valid text
    if (!message || typeof message !== "string") {
      logger.warn({ raw }, "Webhook without usable message text");
      return res.status(400).json({ error: "Missing message text" });
    }

    // STEP 4 — Parse into BUY/SELL
    const { side } = parseTradingViewMessage(message);

    if (!side) {
      logger.warn({ message }, "Unknown TradingView message format");
      return res.status(400).json({ error: "Unknown message format" });
    }

    logger.info({ side, message }, "Received TradingView signal");

    // Emit BUY/SELL internally
    if (side === "BUY") signalBus.emitBuy();
    if (side === "SELL") signalBus.emitSell();

    // Respond immediately, then relay asynchronously
    res.json({ status: "ok" });

    // Relay to external endpoints (async, non-blocking)
    broadcastToRelays(
      {
        message: message, // Send in webhook-compatible format
        type: "tradingview-signal",
        side,
        rawMessage: message,
        ts: Date.now(),
      },
      logger
    );
  });

  // ------------------------------------------------------------
  //  Status API (FSM state, anchors, PnL, position)
  // ------------------------------------------------------------
  app.get("/status", (req, res) => {
    const buyState = fsm?.getBuyState?.() ?? "UNKNOWN";
    const sellState = fsm?.getSellState?.() ?? "UNKNOWN";
    const longPosition = fsm?.getLongPosition?.() ?? null;
    const shortPosition = fsm?.getShortPosition?.() ?? null;
    const anchors = fsm?.getAnchors?.() ?? null;
    const signalHistory = fsm?.getSignalHistory?.() ?? [];
    const pnl = pnlContext?.getSnapshot?.() ?? null;
    
    // Expose full state to get timers
    const fullState = fsm?.getState?.() || {};

    res.json({
      buyState,
      sellState,
      longPosition,
      shortPosition,
      anchors,
      signalHistory,
      pnl,
      timers: {
        buyEntryWindowStartTs: fullState.buyEntryWindowStartTs,
        sellEntryWindowStartTs: fullState.sellEntryWindowStartTs,
        buyProfitWindowStartTs: fullState.buyProfitWindowStartTs,
        sellProfitWindowStartTs: fullState.sellProfitWindowStartTs,
        waitWindowStartTs: fullState.waitWindowStartTs,
        waitWindowDurationMs: fullState.waitWindowDurationMs,
        waitWindowSource: fullState.waitWindowSource,
        waitForBuyEntryStartTs: fullState.waitForBuyEntryStartTs,
        waitForSellEntryStartTs: fullState.waitForSellEntryStartTs,
      }
    });
  });

  // ------------------------------------------------------------
  //  Dashboard UI HTML
  // ------------------------------------------------------------
  app.get("/", (req, res) => {
    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>${config.symbol} Trader</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg: #09090b;
            --card-bg: #18181b;
            --border: #27272a;
            --text: #e4e4e7;
            --text-muted: #a1a1aa;
            --accent-buy: #00f0ff;
            --accent-sell: #ff0055;
            --success: #22c55e;
            --danger: #ef4444;
            --font-main: 'Inter', system-ui, sans-serif;
            --font-mono: 'JetBrains Mono', monospace;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0; padding: 24px;
            font-family: var(--font-main);
            background: var(--bg); color: var(--text);
            line-height: 1.5;
          }
          h1 { margin: 0 0 8px 0; font-weight: 600; letter-spacing: -0.02em; }
          .header { margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; }
          .sub { color: var(--text-muted); font-size: 14px; }
          
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 24px; }
          .card { 
            background: var(--card-bg); 
            border: 1px solid var(--border); 
            border-radius: 12px; 
            padding: 20px; 
            position: relative;
            overflow: hidden;
          }
          
          .label { font-size: 12px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; font-weight: 600; letter-spacing: 0.05em; }
          .value { font-size: 24px; font-weight: 500; font-family: var(--font-mono); }
          .value-sm { font-size: 16px; font-family: var(--font-mono); }
          
          .buy-text { color: var(--accent-buy); }
          .sell-text { color: var(--accent-sell); }
          .pnl-pos { color: var(--success); }
          .pnl-neg { color: var(--danger); }
          
          /* Timer Badge */
          .timer-badge {
            position: absolute;
            top: 16px; right: 16px;
            background: rgba(255,255,255,0.1);
            padding: 4px 8px;
            border-radius: 4px;
            font-family: var(--font-mono);
            font-size: 12px;
            color: #fbbf24;
            display: none;
            animation: pulse 2s infinite;
          }
          @keyframes pulse { 0% { opacity: 0.7; } 50% { opacity: 1; } 100% { opacity: 0.7; } }

          table { width: 100%; border-collapse: collapse; font-size: 13px; }
          th, td { padding: 8px 12px; border-bottom: 1px solid var(--border); text-align: left; }
          th { font-weight: 500; color: var(--text-muted); font-size: 12px; }
          td { font-family: var(--font-mono); }
          
          .relay-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
          
          button { 
            border-radius: 6px; border: 1px solid var(--border); 
            background: #27272a; color: var(--text); 
            padding: 6px 12px; cursor: pointer; font-size: 13px; font-family: var(--font-main);
            transition: all 0.2s;
          }
          button:hover { background: #3f3f46; border-color: #52525b; }
          
          input { 
            width: 100%; padding: 8px 12px; border-radius: 6px; 
            border: 1px solid var(--border); background: #09090b; 
            color: var(--text); font-size: 13px; margin-bottom: 8px; 
            font-family: var(--font-mono);
          }
          input:focus { outline: none; border-color: var(--text-muted); }
          
          .small { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
          
          .status-indicator {
            display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); margin-right: 8px;
          }
          .status-active { background: var(--success); box-shadow: 0 0 8px var(--success); }
        </style>
      </head>
      <body>
      
      <div class="header">
        <div>
          <h1>${config.symbol} <span style="font-weight:300; color:var(--text-muted)">Trader</span></h1>
          <div class="sub">Dual FSM Engine · Independent Long/Short Logic</div>
        </div>
        <div style="text-align:right">
          <div class="label" style="margin:0">System Status</div>
          <div style="display:flex; align-items:center; justify-content:flex-end; margin-top:4px;">
            <span class="status-indicator status-active"></span>
            <span style="font-size:13px; color:var(--success)">Operational</span>
          </div>
        </div>
      </div>

      <div id="cards">Loading...</div>

      <div class="grid">
        <div class="card">
          <div class="label">Recent Trades</div>
          <div id="trades-table" style="max-height: 300px; overflow-y: auto;">No trades yet.</div>
        </div>

        <div class="card">
          <div class="label">Signal History</div>
          <div id="signals-table" style="max-height: 300px; overflow-y: auto;">No signals yet.</div>
        </div>

        <div class="card">
          <div class="label">Relay Configuration</div>
          <input id="relay-url" type="text" placeholder="https://your-endpoint.example.com/hook">
          <button id="add-relay-btn">Add Relay</button>
          <div class="small">Signals are forwarded to these webhooks.</div>
          <div id="relays-list" style="margin-top:12px;">Loading relays...</div>
        </div>
      </div>

      <script>
        const WINDOW_MS = 60000;
        function fmt(v){ return v==null?'-':Number(v).toFixed(2); }
        function cls(v){ return v>0?'pnl-pos':v<0?'pnl-neg':''; }
        
        async function status(){ return (await fetch('/status')).json(); }
        async function relays(){ return (await fetch('/relays')).json(); }
        async function addRelay(url){ return (await fetch('/relays',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})).json(); }
        async function rmRelay(url){ return (await fetch('/relays',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})})).json(); }

        function getTimer(d, state, side) {
          const now = Date.now();
          let start = null;
          let duration = WINDOW_MS;
          
          // Map states to their start timestamps
          if (state === 'BUYENTRY_WINDOW') start = d.timers.buyEntryWindowStartTs;
          else if (state === 'SELLENTRY_WINDOW') start = d.timers.sellEntryWindowStartTs;
          else if (state === 'BUYPROFIT_WINDOW') start = d.timers.buyProfitWindowStartTs;
          else if (state === 'SELLPROFIT_WINDOW') start = d.timers.sellProfitWindowStartTs;
          else if (state === 'WAIT_FOR_BUYENTRY') start = d.timers.waitForBuyEntryStartTs;
          else if (state === 'WAIT_FOR_SELLENTRY') start = d.timers.waitForSellEntryStartTs;
          else if (state === 'WAIT_WINDOW') {
             // For WAIT_WINDOW, we need to check if it belongs to this side
             // The backend provides waitWindowSource, we can infer side
             const src = d.timers.waitWindowSource || '';
             const srcSide = src.includes('BUY') ? 'BUY' : (src.includes('SELL') ? 'SELL' : '');
             if (srcSide === side) {
               start = d.timers.waitWindowStartTs;
               duration = d.timers.waitWindowDurationMs || 0;
             }
          }

          if (!start) return null;
          const elapsed = now - start;
          const remaining = Math.max(0, duration - elapsed);
          return (remaining / 1000).toFixed(1) + 's';
        }

        function renderCards(d){
          const p=d.pnl||{}, lp=d.longPosition||{}, sp=d.shortPosition||{}, a=d.anchors||{}, m=p.metrics||{};
          
          const buyTimer = getTimer(d, d.buyState, 'BUY');
          const sellTimer = getTimer(d, d.sellState, 'SELL');

          document.getElementById('cards').innerHTML = \`
            <div class="grid">
              <!-- BUY SIDE -->
              <div class="card" style="border-top: 3px solid var(--accent-buy)">
                <div class="label">BUY FSM State</div>
                <div class="value buy-text">\${d.buyState}</div>
                \${buyTimer ? \`<div class="timer-badge" style="display:block">\${buyTimer}</div>\` : ''}
                <div style="margin-top:12px; font-size:13px; color:var(--text-muted)">
                  Entry Trigger: <span style="color:var(--text)">\${a.buyEntryTrigger??'-'}</span><br>
                  Stop Loss: <span style="color:var(--text)">\${a.buyStop??'-'}</span>
                </div>
              </div>

              <!-- SELL SIDE -->
              <div class="card" style="border-top: 3px solid var(--accent-sell)">
                <div class="label">SELL FSM State</div>
                <div class="value sell-text">\${d.sellState}</div>
                \${sellTimer ? \`<div class="timer-badge" style="display:block">\${sellTimer}</div>\` : ''}
                <div style="margin-top:12px; font-size:13px; color:var(--text-muted)">
                  Entry Trigger: <span style="color:var(--text)">\${a.sellEntryTrigger??'-'}</span><br>
                  Stop Loss: <span style="color:var(--text)">\${a.sellStop??'-'}</span>
                </div>
              </div>

              <!-- POSITIONS -->
              <div class="card">
                <div class="label">Active Positions</div>
                <div style="display:flex; flex-direction:column; gap:8px">
                  <div style="display:flex; justify-content:space-between">
                    <span class="sub">LONG</span>
                    <span class="value-sm" style="\${lp.qty?'color:var(--accent-buy)':'color:var(--text-muted)'}">
                      \${lp.qty ? \`\${lp.qty} @ \${fmt(lp.entryPrice)}\` : 'None'}
                    </span>
                  </div>
                  <div style="display:flex; justify-content:space-between">
                    <span class="sub">SHORT</span>
                    <span class="value-sm" style="\${sp.qty?'color:var(--accent-sell)':'color:var(--text-muted)'}">
                      \${sp.qty ? \`\${sp.qty} @ \${fmt(sp.entryPrice)}\` : 'None'}
                    </span>
                  </div>
                </div>
                <div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border); display:flex; justify-content:space-between; align-items:center">
                   <span class="label" style="margin:0">Last Price</span>
                   <span class="value-sm">\${fmt(p.lastPrice)}</span>
                </div>
              </div>
              
              <!-- PNL -->
              <div class="card">
                <div class="label">Performance</div>
                <div class="value \${cls(p.totalPnl)}">\${fmt(p.totalPnl)} <span style="font-size:14px">USDT</span></div>
                <div class="grid" style="grid-template-columns:1fr 1fr; gap:8px; margin:12px 0 0 0">
                  <div>
                    <div class="sub">Realized</div>
                    <div class="\${cls(p.realizedPnl)}">\${fmt(p.realizedPnl)}</div>
                  </div>
                  <div>
                    <div class="sub">Unrealized</div>
                    <div class="\${cls(p.unrealizedPnl)}">\${fmt(p.unrealizedPnl)}</div>
                  </div>
                </div>
                
                <!-- Detailed Stats -->
                <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border)">
                  <div class="grid" style="grid-template-columns:1fr 1fr; gap:12px; margin:0">
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Win Rate</span> 
                      <span class="value-sm">\${fmt(m.winRate)}%</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Profit Factor</span> 
                      <span class="value-sm">\${fmt(m.profitFactor)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Trades</span> 
                      <span class="value-sm">\${p.tradeCount||0} (\${m.winCount}W / \${m.lossCount}L)</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Return</span> 
                      <span class="value-sm">\${fmt(m.pnlPercentage)}%</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Avg Trade</span> 
                      <span class="value-sm">\${fmt(m.avgTradePnl)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Best Trade</span> 
                      <span class="value-sm pnl-pos">\${fmt(m.bestTrade)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Worst Trade</span> 
                      <span class="value-sm pnl-neg">\${fmt(m.worstTrade)}</span>
                    </div>
                    <div style="display:flex; justify-content:space-between">
                      <span class="sub">Gross PnL</span> 
                      <span class="value-sm">\${fmt(m.totalWins)} / \${fmt(m.totalLosses)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          \`;
        }

        function renderTrades(p){
          const h=document.getElementById('trades-table');
          const t=(p&&p.trades)||[];
          if(!t.length){ h.textContent='No trades yet.'; return; }
          h.innerHTML = '<table><thead><tr><th>Time</th><th>Type</th><th>Side</th><th>Qty</th><th>Price</th><th>P&L</th></tr></thead><tbody>' +
            t.slice().reverse().map(r=>{
              const ts=new Date(r.ts).toLocaleTimeString();
              return \`<tr><td>\${ts}</td><td>\${r.type}</td><td class="\${r.side==='BUY'?'buy-text':'sell-text'}">\${r.side}</td><td>\${r.qty}</td><td>\${r.price}</td><td class="\${cls(r.pnl)}">\${fmt(r.pnl)}</td></tr>\`;
            }).join('') + '</tbody></table>';
        }

        function renderSignals(s){
          const h=document.getElementById('signals-table');
          const list=s||[];
          if(!list.length){ h.textContent='No signals yet.'; return; }
          h.innerHTML = '<table><thead><tr><th>Time</th><th>Side</th><th>FSM State</th></tr></thead><tbody>' +
            list.map(r=>{
              const ts=new Date(r.ts).toLocaleTimeString();
              const sideClass=r.side==='BUY'?'buy-text':'sell-text';
              return \`<tr><td>\${ts}</td><td class="\${sideClass}">\${r.side}</td><td>\${r.state}</td></tr>\`;
            }).join('') + '</tbody></table>';
        }

        function renderRelays(d){
          const h=document.getElementById('relays-list');
          const list=d.relays||[];
          if(!list.length){ h.textContent='No relays registered.'; return; }
          h.innerHTML=list.map(u=>\`<div class="relay-row"><div>\${u}</div><button data-url="\${u}">Remove</button></div>\`).join('');
          h.querySelectorAll('button').forEach(btn=>{
            btn.onclick=async ()=>{ await rmRelay(btn.dataset.url); renderRelays(await relays()); };
          });
        }

        async function refresh(){
          const [s,r]=await Promise.all([status(),relays()]);
          renderCards(s); renderSignals(s.signalHistory); renderTrades(s.pnl); renderRelays(r);
        }

        document.addEventListener('DOMContentLoaded',()=>{
          document.getElementById('add-relay-btn').onclick=async ()=>{
            const url=document.getElementById('relay-url').value.trim();
            if(url){ await addRelay(url); document.getElementById('relay-url').value=''; renderRelays(await relays()); }
          };
          refresh(); 
          // Refresh faster for timer updates (500ms)
          setInterval(refresh, 500);
        });
      </script>
      </body></html>
    `);
  });

  // Relay Management API
  app.get("/relays", (req, res) => res.json({ relays: [...relays] }));
  app.post("/relays", (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });

    // Validate URL format
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "URL must use HTTP or HTTPS" });
      }
    } catch (err) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    relays.add(url);
    logger.info({ url }, "Added relay URL");
    res.json({ ok: true, relays: [...relays] });
  });
  app.delete("/relays", (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url is required" });
    relays.delete(url);
    logger.info({ url }, "Removed relay URL");
    res.json({ ok: true, relays: [...relays] });
  });

  return app;
}
